/*
 * privprobe — can LD_PRELOAD reach glibc's *internal* configuration paths?
 *
 * glibc opens its own configuration files — the NSS "files" databases and the
 * resolver configuration — through internal aliases that never cross the PLT,
 * so an ordinary LD_PRELOAD hook is bypassed and the *host* /etc files win.
 * Those internal entry points are exported, but versioned GLIBC_PRIVATE.
 *
 * Interposing them is therefore the difference between "guest /etc/hosts and
 * /etc/resolv.conf are honoured" and "name resolution silently uses the host".
 *
 * `getaddrinfo` is a public control: when its line appears the preload is
 * active, so a missing line below it means that interface could not be bound.
 *
 * Build twice: as-is (unversioned) and with -DUSE_VERSION_SCRIPT plus
 * privprobe.map, to compare how the loader treats each form.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <netdb.h>
#include <stdio.h>
#include <stdlib.h>

static int enabled(void)
{
	static int cached = -1;

	if (cached < 0) {
		const char *v = getenv("PRIVPROBE_DEBUG");

		cached = (v && *v) ? 1 : 0;
	}
	return cached;
}

static void note(const char *what, const char *arg, void *real)
{
	if (enabled())
		fprintf(stderr, "[PRIVHOOK] %s(%s) real=%p\n", what, arg ? arg : "-", real);
}

#ifndef USE_VERSION_SCRIPT
int getaddrinfo(const char *node, const char *service, const struct addrinfo *hints,
		struct addrinfo **res)
{
	static int (*real)(const char *, const char *, const struct addrinfo *, struct addrinfo **);

	if (!real)
		real = (int (*)(const char *, const char *, const struct addrinfo *,
				struct addrinfo **))dlsym(RTLD_NEXT, "getaddrinfo");
	note("getaddrinfo", node, (void *)real);
	return real ? real(node, service, hints, res) : EAI_SYSTEM;
}
#endif

FILE *__nss_files_fopen(const char *path)
{
	static FILE *(*real)(const char *);

	if (!real)
		real = (FILE * (*)(const char *)) dlsym(RTLD_NEXT, "__nss_files_fopen");
	note("__nss_files_fopen", path, (void *)real);
	return real ? real(path) : NULL;
}

void *__resolv_context_get(void)
{
	static void *(*real)(void);

	if (!real)
		real = (void *(*)(void))dlsym(RTLD_NEXT, "__resolv_context_get");
	note("__resolv_context_get", NULL, (void *)real);
	return real ? real() : NULL;
}
