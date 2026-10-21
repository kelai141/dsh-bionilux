#!/usr/bin/env php
<?php

declare(strict_types=1);

/*
 * Composer + MongoDB acceptance driver for the Monolog checkout.
 *
 * Runs inside the bionilux guest with the mongodb extension available:
 *
 *   php composer_mongodb.php --project=/root/polyglot/projects/php-monolog
 *
 * The driver verifies the real driver ABI, runs composer install without
 * ignoring platform requirements, checks the installed platform set, and
 * runs the whole upstream Monolog suite. Any requested suite failure fails
 * the exit status. --mongo-only explicitly requests the MongoDB handler
 * subset instead of the full suite.
 *
 * Fixture cleanup is opt-in with --clean-fixtures. It never follows
 * symlinks and refuses to run without Git metadata, so tracked fixtures
 * cannot be removed. Normal runs let the upstream tearDown clean itself.
 */

$options = getopt('', [
    'project::',
    'composer::',
    'phpunit::',
    'full',
    'mongo-only',
    'skip-install',
    'skip-tests',
    'clean-fixtures',
    'help',
]);

if (isset($options['help'])) {
    fwrite(STDERR, "usage: composer_mongodb.php [--project=DIR] [--composer=FILE] [--mongo-only] [--skip-install] [--skip-tests] [--clean-fixtures]\n");
    exit(0);
}

$project = rtrim((string) ($options['project'] ?? getenv('BIONILUX_COMPOSER_PROJECT') ?: '/root/polyglot/projects/php-monolog'), '/');
$composer = (string) ($options['composer'] ?? getenv('BIONILUX_COMPOSER') ?: '/usr/bin/composer');
$composerJson = $project.'/composer.json';
$lockFile = $project.'/composer.lock';
$autoload = $project.'/vendor/autoload.php';
$phpunit = $project.'/vendor/bin/phpunit';
$mongoTest = $project.'/tests/Monolog/Handler/MongoDBHandlerTest.php';
$fixtures = $project.'/tests/Monolog/Handler/Fixtures';

$failed = 0;

function say(string $line): void
{
    echo $line, "\n";
}

function check(string $label, bool $ok, string $detail = ''): bool
{
    say(sprintf('%s %s%s', $ok ? 'PASS' : 'FAIL', $label, $detail === '' ? '' : ' ('.$detail.')'));

    return $ok;
}

function tailLines(string $text, int $limit): string
{
    $lines = preg_split('/\R/', trim($text));

    return implode("\n", array_slice($lines, max(0, count($lines) - $limit)));
}

/**
 * @param list<string> $command
 * @param array<string,string> $extraEnv
 * @return array{0:int,1:string}
 */
function runCommand(array $command, array $extraEnv = [], ?string $cwd = null, bool $silent = false): array
{
    $env = getenv();
    if (!is_array($env)) {
        $env = [];
    }
    foreach ($extraEnv as $key => $value) {
        $env[$key] = $value;
    }

    $descriptors = [1 => ['pipe', 'w'], 2 => ['pipe', 'w']];
    $process = proc_open($command, $descriptors, $pipes, $cwd, $env);
    if (!is_resource($process)) {
        return [127, 'proc_open failed'];
    }

    $streams = [1 => $pipes[1], 2 => $pipes[2]];
    foreach ($streams as $stream) {
        stream_set_blocking($stream, false);
    }

    $output = '';
    while ($streams !== []) {
        $read = array_values($streams);
        $write = null;
        $except = null;
        if (stream_select($read, $write, $except, 1) === false) {
            break;
        }
        foreach ($read as $stream) {
            $chunk = fread($stream, 65536);
            if ($chunk === false) {
                continue;
            }
            if ($chunk === '') {
                if (feof($stream)) {
                    foreach ($streams as $key => $candidate) {
                        if ($candidate === $stream) {
                            fclose($stream);
                            unset($streams[$key]);
                        }
                    }
                }
                continue;
            }
            $output .= $chunk;
            if (!$silent) {
                echo $chunk;
            }
        }
    }

    foreach ($streams as $stream) {
        fclose($stream);
    }

    return [proc_close($process), $output];
}

/**
 * Tracked fixture paths, absolute. Null means Git could not answer and the
 * caller must not delete anything.
 */
function trackedFixtures(string $project): ?array
{
    [$rc, $out] = runCommand(
        ['git', '-C', $project, 'ls-files', '-z', '--', 'tests/Monolog/Handler/Fixtures'],
        [],
        null,
        true
    );
    if ($rc !== 0) {
        return null;
    }
    $tracked = [];
    foreach (explode("\0", $out) as $relative) {
        if ($relative !== '') {
            $tracked[$project.'/'.$relative] = true;
        }
    }

    return $tracked;
}

/**
 * Remove a generated subtree. Symlinks are unlinked, never traversed, and
 * tracked paths are left untouched.
 */
function removeTree(string $path, array $tracked, int &$protected): int
{
    $removed = 0;
    foreach (scandir($path) ?: [] as $entry) {
        if ($entry === '.' || $entry === '..') {
            continue;
        }
        $child = $path.'/'.$entry;
        if (isset($tracked[$child])) {
            $protected++;
            continue;
        }
        if (is_link($child)) {
            unlink($child);
            $removed++;
            continue;
        }
        if (is_dir($child)) {
            $removed += removeTree($child, $tracked, $protected);
            continue;
        }
        unlink($child);
        $removed++;
    }
    @rmdir($path);

    return $removed;
}

/**
 * Remove only generated fixture names. A symlink is never followed.
 *
 * @return int number of removed entries
 */
function cleanFixtures(string $dir, array $tracked, int &$protected): int
{
    if (!is_dir($dir) || is_link($dir)) {
        return 0;
    }

    $removed = 0;
    foreach (scandir($dir) ?: [] as $entry) {
        if ($entry === '.' || $entry === '..') {
            continue;
        }
        $path = $dir.'/'.$entry;
        if (isset($tracked[$path])) {
            $protected++;
            continue;
        }
        $generated = preg_match('/^(?:[0-9]+|stream-wrapper-.*)$/', $entry) === 1;
        if (is_link($path)) {
            if ($generated || str_ends_with($entry, '.rot')) {
                unlink($path);
                $removed++;
            }
            continue;
        }
        if (is_dir($path)) {
            if ($generated) {
                $removed += removeTree($path, $tracked, $protected);
            }
            continue;
        }
        if (str_ends_with($entry, '.rot')) {
            unlink($path);
            $removed++;
        }
    }

    return $removed;
}

say('== environment ==');
$failed += check('php >= 8.1', PHP_VERSION_ID >= 80100, PHP_VERSION) ? 0 : 1;
$failed += check('ext-mongodb loaded', extension_loaded('mongodb'), (string) phpversion('mongodb')) ? 0 : 1;
$failed += check('composer.json present', is_file($composerJson), $composerJson) ? 0 : 1;

$extensionFile = null;
if (extension_loaded('mongodb')) {
    // ReflectionExtension exposes no file name; the loaded mapping does.
    $maps = @file_get_contents('/proc/self/maps');
    if (is_string($maps) && preg_match('~(/(?:[^\s]+/)?mongodb\.so)~', $maps, $match) === 1) {
        $extensionFile = $match[1];
    }
    if ($extensionFile === null) {
        $scanDir = getenv('PHP_INI_SCAN_DIR');
        foreach ($scanDir === false ? [] : explode(':', $scanDir) as $dir) {
            foreach (scandir($dir) ?: [] as $entry) {
                if (!str_ends_with($entry, '.ini')) {
                    continue;
                }
                $ini = (string) @file_get_contents($dir.'/'.$entry);
                if (preg_match('/^\s*extension\s*=\s*(\S*mongodb\.so)\s*$/m', $ini, $match) === 1) {
                    $extensionFile = $match[1];
                }
            }
        }
    }
    $failed += check('driver classes', class_exists('MongoDB\\Driver\\Manager') && class_exists('MongoDB\\BSON\\Document')) ? 0 : 1;
    if ($extensionFile !== null) {
        // Debian ships libsnappy as a separate package. When the driver was
        // unpacked with dpkg-deb, expose that library to child processes too.
        $prefixLib = dirname(dirname(dirname($extensionFile))).'/x86_64-linux-gnu';
        $libraryPath = (string) getenv('LD_LIBRARY_PATH');
        if (is_dir($prefixLib) && !in_array($prefixLib, explode(':', $libraryPath), true)) {
            putenv('LD_LIBRARY_PATH='.$prefixLib.($libraryPath === '' ? '' : ':'.$libraryPath));
            check('extension library path', true, $prefixLib);
        }
    }
}

if (!extension_loaded('mongodb')) {
    // The driver is a hard prerequisite; loading the library without it
    // would only turn a clear check failure into a fatal error.
    say('RESULT=FAIL('.$failed.')');
    exit(1);
}

// Build a php command that keeps the driver loaded for child processes.
$phpCommand = [PHP_BINARY];
[$probeRc, $probeOut] = runCommand([PHP_BINARY, '-r', 'echo extension_loaded("mongodb") ? "1" : "0";'], [], null, true);
if (trim($probeOut) !== '1' && $extensionFile !== null) {
    $phpCommand[] = '-d';
    $phpCommand[] = 'extension='.$extensionFile;
}

$composerEnv = [
    'COMPOSER_ALLOW_SUPERUSER' => '1',
    'COMPOSER_NO_INTERACTION' => '1',
    'COMPOSER_NO_PROGRESS' => '1',
];

if (!isset($options['skip-install'])) {
    say('== composer install (real platform requirements) ==');
    if (!is_file($composer) || !is_file($composerJson)) {
        $failed++;
        check('composer install prerequisites', false, $composer.' / '.$composerJson);
    } else {
        [$rc, $out] = runCommand(array_merge($phpCommand, [$composer, 'install', '--no-interaction', '--no-progress']), $composerEnv, $project);
        $failed += check('composer install exited 0', $rc === 0, 'rc='.$rc) ? 0 : 1;
        if ($rc !== 0) {
            say(tailLines($out, 30));
        }
    }
}

say('== installed dependency set ==');
$failed += check('vendor/autoload.php present', is_file($autoload), $autoload) ? 0 : 1;
if (is_file($autoload)) {
    require $autoload;
    $failed += check('mongodb/mongodb Client available', class_exists('MongoDB\\Client')) ? 0 : 1;
    $failed += check('Monolog MongoDBHandler available', class_exists('Monolog\\Handler\\MongoDBHandler')) ? 0 : 1;
    $failed += check('Monolog Logger available', class_exists('Monolog\\Logger')) ? 0 : 1;

    $manager = new MongoDB\Driver\Manager('mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=200');
    $doc = MongoDB\BSON\Document::fromPHP(['n' => 42, 'when' => new MongoDB\BSON\UTCDateTime(0)]);
    $back = (array) $doc->toPHP();
    $failed += check('BSON roundtrip', ($back['n'] ?? null) === 42 && ($back['when'] ?? null) instanceof MongoDB\BSON\UTCDateTime) ? 0 : 1;

    try {
        $manager->executeCommand('admin', new MongoDB\Driver\Command(['ping' => 1]));
        check('driver command path', true, 'server reachable');
    } catch (MongoDB\Driver\Exception\ConnectionException $exception) {
        check('driver command path', true, 'no server, connection error as expected');
    } catch (Throwable $exception) {
        check('driver command path', false, get_class($exception).': '.$exception->getMessage());
        $failed++;
    }

    // monolog/monolog sets config.lock=false, so a library checkout may have
    // no composer.lock. Fall back to the installed package metadata.
    $installedFile = $project.'/vendor/composer/installed.json';
    $metadata = null;
    if (is_file($lockFile)) {
        $metadata = json_decode((string) file_get_contents($lockFile), true);
    } elseif (is_file($installedFile)) {
        $metadata = json_decode((string) file_get_contents($installedFile), true);
    }
    $packages = $metadata['packages'] ?? $metadata ?? [];
    $mongoPackage = null;
    foreach ($packages as $package) {
        if (($package['name'] ?? '') === 'mongodb/mongodb') {
            $mongoPackage = $package;
        }
    }
    $requiresExtension = is_array($mongoPackage) && isset(($mongoPackage['require'] ?? [])['ext-mongodb']);
    $failed += check('installed mongodb/mongodb metadata', is_array($mongoPackage), is_array($mongoPackage) ? (string) $mongoPackage['version'] : 'missing') ? 0 : 1;
    $failed += check('locked package requires ext-mongodb', $requiresExtension) ? 0 : 1;
}

if (is_file($composer)) {
    say('== composer check-platform-reqs ==');
    [$rc, $out] = runCommand(array_merge($phpCommand, [$composer, 'check-platform-reqs', '--no-interaction']), $composerEnv, $project);
    $failed += check('platform requirements satisfied', $rc === 0, 'rc='.$rc) ? 0 : 1;
    if ($rc !== 0) {
        say(tailLines($out, 20));
    }
}

if (!isset($options['skip-tests']) && is_file($phpunit) && is_file($mongoTest)) {
    say('== upstream MongoDBHandlerTest ==');
    [$rc, $out] = runCommand(array_merge($phpCommand, [$phpunit, '--colors=never', '--do-not-cache-result', $mongoTest]), [], $project);
    $passed = $rc === 0 && preg_match('/Tests: ([0-9]+), Assertions: ([0-9]+)/', $out, $m) === 1;
    $failed += check('MongoDBHandlerTest exited 0', $passed, $passed ? $m[0] : 'rc='.$rc) ? 0 : 1;

    if (!isset($options['mongo-only'])) {
        say('== full upstream suite ==');
        if (isset($options['clean-fixtures'])) {
            $tracked = trackedFixtures($project);
            if ($tracked === null) {
                $failed++;
                check('fixture cleanup metadata', false, 'git ls-files failed');
            } else {
                $protected = 0;
                $removed = cleanFixtures($fixtures, $tracked, $protected);
                say('cleaned fixture entries: '.$removed.'; tracked entries kept: '.$protected);
            }
        }
        [$rc, $out] = runCommand(array_merge($phpCommand, [$phpunit, '--colors=never', '--do-not-cache-result']), [], $project);
        $summary = null;
        foreach (preg_split('/\R/', $out) as $line) {
            if (preg_match('/^Tests: /', $line) === 1) {
                $summary = $line;
            }
        }
        say('FULL_SUITE_RC='.$rc);
        say('FULL_SUITE_SUMMARY='.($summary ?? 'not parsed'));
        $failed += check('full suite exited 0', $rc === 0, 'rc='.$rc) ? 0 : 1;
    }
}

if (!isset($options['skip-install']) && is_file($composer) && is_file($composerJson)) {
    say('== incremental composer install ==');
    [$rc, $out] = runCommand(array_merge($phpCommand, [$composer, 'install', '--no-interaction', '--no-progress']), $composerEnv, $project);
    $incremental = $rc === 0 && (str_contains($out, 'Nothing to install') || str_contains($out, 'No install operations'));
    $failed += check('second composer install is a no-op', $incremental, 'rc='.$rc) ? 0 : 1;
    if (!$incremental) {
        say(tailLines($out, 20));
    }
}

say($failed === 0 ? 'RESULT=PASS' : 'RESULT=FAIL('.$failed.')');
exit($failed === 0 ? 0 : 1);
