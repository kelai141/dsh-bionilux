#!/usr/bin/env bash
# Run inside the guest as the actual app UID against an isolated rspec-core
# checkout. See docs/ACCEPTANCE_FIXES_FOLLOWUP.md for dependency preparation.
set -euo pipefail
: "${RSPEC_PROJECT:?set RSPEC_PROJECT to an isolated checkout ending in /rspec-core}"
: "${BUNDLE_PATH:?set BUNDLE_PATH to the installed test dependencies}"
: "${EVIDENCE_DIR:?set EVIDENCE_DIR outside the checkout}"
[[ "${RSPEC_PROJECT##*/}" == rspec-core ]] || { echo 'upstream tests require the rspec-core directory name' >&2; exit 2; }
mkdir -p "$EVIDENCE_DIR"
cd "$RSPEC_PROJECT"
export LC_ALL="${LC_ALL:-C.UTF-8}" LANG="${LANG:-C.UTF-8}"
grep '^Uid:' /proc/self/status | tee "$EVIDENCE_DIR/actual-uid.log"
ruby --version | tee "$EVIDENCE_DIR/toolchain.log"
bundle check | tee "$EVIDENCE_DIR/dependencies.log"
bundle exec ruby -rerb -e 'p [RUBY_VERSION, ERB.version, Gem.loaded_specs["erb"].full_gem_path]' | tee -a "$EVIDENCE_DIR/dependencies.log"
# Ruby's VM compiles real project sources to bytecode. Persist a build cache
# outside the checkout and rebuild only changed inputs on the next invocation.
export BN_RUBY_CACHE="$EVIDENCE_DIR/bytecode"
build_bytecode() {
  bundle exec ruby -rdigest -rfileutils -e '
    cache = ENV.fetch("BN_RUBY_CACHE"); FileUtils.mkdir_p(cache)
    built = 0; reused = 0
    Dir["lib/**/*.rb"].sort.each do |source|
      digest = Digest::SHA256.file(source).hexdigest
      output = File.join(cache, source.tr("/", "_") + ".iseq")
      key = output + ".sha256"
      if File.file?(output) && File.file?(key) && File.read(key) == digest
        RubyVM::InstructionSequence.load_from_binary(File.binread(output)); reused += 1
      else
        File.binwrite(output, RubyVM::InstructionSequence.compile_file(source).to_binary)
        File.write(key, digest); built += 1
      end
    end
    abort "no project sources" if built + reused == 0
    puts "bytecode built=#{built} reused=#{reused}"
  '
}
build_bytecode | tee "$EVIDENCE_DIR/build.log"
bundle exec rspec --seed 26142 > "$EVIDENCE_DIR/unit.log" 2>&1
tail -6 "$EVIDENCE_DIR/unit.log"
build_bytecode | tee "$EVIDENCE_DIR/incremental.log"
# Exercise real content invalidation without changing upstream source/tests.
cache_file=$(find "$BN_RUBY_CACHE" -name '*.sha256' -print -quit)
printf 'stale' > "$cache_file"
build_bytecode | tee "$EVIDENCE_DIR/invalidation.log"
grep -q 'built=1 ' "$EVIDENCE_DIR/invalidation.log"
bundle exec ruby -rrspec/core -e 'abort unless RSpec::Core::Runner.run(["--dry-run", "spec/rspec/core_spec.rb"]) == 0' > "$EVIDENCE_DIR/run.log" 2>&1
echo RUBY_ACCEPTANCE_PASS