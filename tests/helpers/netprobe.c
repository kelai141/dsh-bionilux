/*
 * netprobe — diagnose how *this* process can reach the network and DNS.
 *
 * It is deliberately libc-only (no NSS modules, no getaddrinfo for the raw
 * cases) so the three layers can be told apart:
 *
 *   - iface       : which addresses this process actually has
 *   - resolvconf  : what the C library is told to ask
 *   - udp         : can this process reach a DNS server with a raw UDP query
 *   - tcp         : can this process open a TCP connection
 *   - gai         : does the C library's own resolver work
 *
 * Builds against both glibc (Linux host / Debian guest) and Bionic (Android),
 * so the same probe can be run on both sides of the runtime boundary.
 *
 * Output is `key=value` lines, one probe per invocation, so shell tests can
 * assert on it without parsing prose.
 */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <ifaddrs.h>
#include <netdb.h>
#include <netinet/in.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

#ifdef __GLIBC__
#include <arpa/nameser.h>
#include <resolv.h>
#endif

#define DEFAULT_TIMEOUT_MS 3000

static void die(const char *what)
{
	fprintf(stderr, "netprobe: %s: %s\n", what, strerror(errno));
	exit(2);
}

static long now_ms(void)
{
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

/* ---------- DNS wire format ---------- */

static int build_query(unsigned char *buf, size_t cap, const char *name, uint16_t id)
{
	size_t n = 12;
	const char *p = name;

	if (cap < 12)
		return -1;
	buf[0] = (unsigned char)(id >> 8);
	buf[1] = (unsigned char)(id & 0xff);
	buf[2] = 0x01; /* RD */
	buf[3] = 0x00;
	buf[4] = 0x00;
	buf[5] = 0x01; /* qdcount = 1 */
	memset(buf + 6, 0, 6);

	while (*p) {
		const char *dot = strchr(p, '.');
		size_t len = dot ? (size_t)(dot - p) : strlen(p);

		if (len == 0 || len > 63 || n + len + 2 > cap)
			return -1;
		buf[n++] = (unsigned char)len;
		memcpy(buf + n, p, len);
		n += len;
		if (!dot)
			break;
		p = dot + 1;
	}
	buf[n++] = 0x00;      /* root label */
	buf[n++] = 0x00;      /* QTYPE  A   */
	buf[n++] = 0x01;
	buf[n++] = 0x00;      /* QCLASS IN  */
	buf[n++] = 0x01;
	return (int)n;
}

static int skip_name(const unsigned char *b, size_t len, size_t *off)
{
	size_t o = *off;

	while (o < len) {
		unsigned char c = b[o];

		if (c == 0x00) {
			o++;
			break;
		}
		if ((c & 0xc0) == 0xc0) {
			o += 2;
			break;
		}
		o += 1 + (size_t)c;
	}
	if (o > len)
		return -1;
	*off = o;
	return 0;
}

/* Parse a DNS reply into rcode + A/AAAA answers. Returns 0 when the reply is
 * a well-formed response for our query id. */
static int parse_reply(const unsigned char *b, size_t len, uint16_t id, int *rcode,
		       char *addrs, size_t addrs_cap)
{
	size_t off = 0;
	unsigned int qd, an;
	int found = 0;

	if (len < 12)
		return -1;
	if (((unsigned)(b[0] << 8) | b[1]) != id)
		return -1;
	if (!(b[2] & 0x80)) /* QR */
		return -1;

	*rcode = b[3] & 0x0f;
	qd = ((unsigned)b[4] << 8) | b[5];
	an = ((unsigned)b[6] << 8) | b[7];

	off = 12;
	for (unsigned int i = 0; i < qd; i++) {
		if (skip_name(b, len, &off) < 0 || off + 4 > len)
			return -1;
		off += 4;
	}
	for (unsigned int i = 0; i < an; i++) {
		unsigned int type, rdlen;
		char txt[INET6_ADDRSTRLEN];

		if (skip_name(b, len, &off) < 0 || off + 10 > len)
			return -1;
		type = ((unsigned)b[off] << 8) | b[off + 1];
		rdlen = ((unsigned)b[off + 8] << 8) | b[off + 9];
		off += 10;
		if (off + rdlen > len)
			return -1;

		txt[0] = '\0';
		if (type == 1 && rdlen == 4) {
			inet_ntop(AF_INET, b + off, txt, sizeof(txt));
		} else if (type == 28 && rdlen == 16) {
			inet_ntop(AF_INET6, b + off, txt, sizeof(txt));
		}
		if (txt[0]) {
			size_t used = strlen(addrs);

			snprintf(addrs + used, addrs_cap - used, "%s%s", found ? "," : "", txt);
			found++;
		}
		off += rdlen;
	}
	return found;
}

/* ---------- address helpers ---------- */

/* Resolve a numeric literal without touching the NSS/resolver path, so the raw
 * probes stay usable in a static glibc binary (where getaddrinfo cannot load
 * libnss_dns) and in the guest. */
static int fill_sockaddr(const char *host, const char *port, struct sockaddr_storage *ss,
			 socklen_t *slen)
{
	long p = strtol(port, NULL, 10);

	memset(ss, 0, sizeof(*ss));
	if (p <= 0 || p > 65535)
		return -1;

	if (strchr(host, ':')) {
		struct sockaddr_in6 *sin6 = (struct sockaddr_in6 *)ss;

		if (inet_pton(AF_INET6, host, &sin6->sin6_addr) != 1)
			return -1;
		sin6->sin6_family = AF_INET6;
		sin6->sin6_port = htons((uint16_t)p);
		*slen = sizeof(*sin6);
		return 0;
	}
	{
		struct sockaddr_in *sin = (struct sockaddr_in *)ss;

		if (inet_pton(AF_INET, host, &sin->sin_addr) != 1)
			return -1;
		sin->sin_family = AF_INET;
		sin->sin_port = htons((uint16_t)p);
		*slen = sizeof(*sin);
	}
	return 0;
}

static const char *fam_name(int f)
{
	return f == AF_INET ? "inet" : f == AF_INET6 ? "inet6" : "other";
}

/* ---------- probes ---------- */

static int cmd_iface(void)
{
	struct ifaddrs *ifa, *p;
	int n = 0;

	if (getifaddrs(&ifa) != 0)
		die("getifaddrs");
	for (p = ifa; p; p = p->ifa_next) {
		char buf[INET6_ADDRSTRLEN];
		const void *src = NULL;

		if (!p->ifa_addr)
			continue;
		if (p->ifa_addr->sa_family == AF_INET)
			src = &((struct sockaddr_in *)p->ifa_addr)->sin_addr;
		else if (p->ifa_addr->sa_family == AF_INET6)
			src = &((struct sockaddr_in6 *)p->ifa_addr)->sin6_addr;
		if (!src)
			continue;
		if (!inet_ntop(p->ifa_addr->sa_family, src, buf, sizeof(buf)))
			continue;
		printf("iface=%s family=%s addr=%s\n", p->ifa_name,
		       fam_name(p->ifa_addr->sa_family), buf);
		n++;
	}
	freeifaddrs(ifa);
	printf("interfaces=%d\n", n);
	return n > 0 ? 0 : 1;
}

static int cmd_resolvconf(void)
{
	FILE *f = fopen("/etc/resolv.conf", "r");
	char line[512];
	int n = 0;

	if (!f) {
		printf("resolvconf=missing errno=%d\n", errno);
		return 1;
	}
	while (fgets(line, sizeof(line), f)) {
		char *s = line;

		while (*s == ' ' || *s == '\t')
			s++;
		if (strncmp(s, "nameserver", 10) != 0)
			continue;
		s += 10;
		while (*s == ' ' || *s == '\t')
			s++;
		s[strcspn(s, "\r\n")] = '\0';
		if (*s) {
			printf("nameserver=%s\n", s);
			n++;
		}
	}
	fclose(f);
	printf("nameservers=%d\n", n);
	return n > 0 ? 0 : 1;
}

static int cmd_udp(const char *host, const char *port, const char *name, long timeout_ms)
{
	struct sockaddr_storage ss;
	socklen_t slen;
	unsigned char q[512], r[2048];
	uint16_t id = (uint16_t)(getpid() & 0xffff);
	char addrs[512] = "";
	int fd, qlen, rcode = -1, n, family;
	long t0, dt;
	struct pollfd pfd;

	if (fill_sockaddr(host, port, &ss, &slen) != 0) {
		printf("probe=udp target=%s:%s name=%s status=bad-address\n", host, port, name);
		return 1;
	}
	family = ss.ss_family;
	qlen = build_query(q, sizeof(q), name, id);
	if (qlen < 0) {
		printf("probe=udp target=%s:%s name=%s status=bad-name\n", host, port, name);
		return 1;
	}

	fd = socket(family, SOCK_DGRAM, 0);
	if (fd < 0) {
		printf("probe=udp target=%s:%s name=%s status=socket-failed errno=%d %s\n", host, port,
		       name, errno, strerror(errno));
		return 1;
	}

	t0 = now_ms();
	if (sendto(fd, q, (size_t)qlen, 0, (struct sockaddr *)&ss, slen) < 0) {
		printf("probe=udp target=%s:%s name=%s status=send-failed errno=%d %s\n", host, port,
		       name, errno, strerror(errno));
		close(fd);
		return 1;
	}

	pfd.fd = fd;
	pfd.events = POLLIN;
	n = poll(&pfd, 1, (int)timeout_ms);
	dt = now_ms() - t0;
	if (n <= 0) {
		printf("probe=udp target=%s:%s name=%s status=%s ms=%ld\n", host, port, name,
		       n == 0 ? "timeout" : "poll-failed", dt);
		close(fd);
		return 1;
	}

	n = (int)recv(fd, r, sizeof(r), 0);
	if (n < 0) {
		printf("probe=udp target=%s:%s name=%s status=recv-failed errno=%d %s\n", host, port,
		       name, errno, strerror(errno));
		close(fd);
		return 1;
	}
	close(fd);

	n = parse_reply(r, (size_t)n, id, &rcode, addrs, sizeof(addrs));
	printf("probe=udp target=%s:%s name=%s status=ok ms=%ld rcode=%d answers=%d addrs=%s\n", host,
	       port, name, dt, rcode, n < 0 ? 0 : n, n < 0 ? "-" : addrs);
	return n > 0 ? 0 : 1;
}

static int cmd_tcp(const char *host, const char *port, long timeout_ms)
{
	struct sockaddr_storage ss;
	socklen_t slen;
	int fd, rc;
	long t0, dt;
	struct pollfd pfd;
	int err = 0;
	socklen_t elen = sizeof(err);

	if (fill_sockaddr(host, port, &ss, &slen) != 0) {
		printf("probe=tcp target=%s:%s status=bad-address\n", host, port);
		return 1;
	}
	fd = socket(ss.ss_family, SOCK_STREAM, 0);
	if (fd < 0)
		die("socket");
	fcntl(fd, F_SETFL, fcntl(fd, F_GETFL, 0) | O_NONBLOCK);

	t0 = now_ms();
	rc = connect(fd, (struct sockaddr *)&ss, slen);
	if (rc != 0 && errno != EINPROGRESS) {
		printf("probe=tcp target=%s:%s status=connect-failed errno=%d %s\n", host, port, errno,
		       strerror(errno));
		close(fd);
		return 1;
	}
	if (rc != 0) {
		pfd.fd = fd;
		pfd.events = POLLOUT;
		if (poll(&pfd, 1, (int)timeout_ms) <= 0) {
			printf("probe=tcp target=%s:%s status=timeout ms=%ld\n", host, port,
			       now_ms() - t0);
			close(fd);
			return 1;
		}
		if (getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &elen) != 0 || err != 0) {
			printf("probe=tcp target=%s:%s status=connect-failed errno=%d %s\n", host, port,
			       err, strerror(err));
			close(fd);
			return 1;
		}
	}
	dt = now_ms() - t0;
	printf("probe=tcp target=%s:%s status=ok ms=%ld\n", host, port, dt);
	close(fd);
	return 0;
}

static int cmd_gai(const char *name)
{
	struct addrinfo hints, *res = NULL, *p;
	int rc, n = 0;
	char addrs[512] = "";
	long t0 = now_ms();

	memset(&hints, 0, sizeof(hints));
	hints.ai_family = AF_UNSPEC;
	hints.ai_socktype = SOCK_STREAM;
	rc = getaddrinfo(name, NULL, &hints, &res);
	if (rc != 0) {
		printf("probe=gai name=%s status=failed ms=%ld gai=%d %s\n", name, now_ms() - t0, rc,
		       gai_strerror(rc));
		return 1;
	}
	for (p = res; p; p = p->ai_next) {
		char buf[INET6_ADDRSTRLEN];
		const void *src = p->ai_family == AF_INET
					  ? (const void *)&((struct sockaddr_in *)p->ai_addr)->sin_addr
					  : (const void *)&((struct sockaddr_in6 *)p->ai_addr)->sin6_addr;
		size_t used;

		if (!inet_ntop(p->ai_family, src, buf, sizeof(buf)))
			continue;
		used = strlen(addrs);
		snprintf(addrs + used, sizeof(addrs) - used, "%s%s", n ? "," : "", buf);
		n++;
	}
	freeaddrinfo(res);
	printf("probe=gai name=%s status=ok ms=%ld addrs=%s\n", name, now_ms() - t0, addrs);
	return n > 0 ? 0 : 1;
}

#ifdef __GLIBC__
/* Report what the C library's resolver *actually* loaded. This separates
 * "the resolver read our nameserver list" from "the resolver is using its
 * built-in 127.0.0.1 default because it never found the file". */
static int cmd_res_state(void)
{
	struct __res_state *st;
	int n;

	res_init();
	st = __res_state();
	n = st->nscount;
	printf("res_nscount=%d\n", n);
	for (int i = 0; i < n && i < MAXNS; i++) {
		char buf[INET6_ADDRSTRLEN] = "-";
		struct sockaddr_in *sin = &st->nsaddr_list[i];

		inet_ntop(AF_INET, &sin->sin_addr, buf, sizeof(buf));
		printf("res_ns%d=%s:%u\n", i, buf, (unsigned)ntohs(sin->sin_port));
	}
	printf("res_options=0x%lx\n", (unsigned long)st->options);
	printf("res_ndots=%d res_retrans=%d res_retry=%d\n", st->ndots, st->retrans, st->retry);
	printf("res_defdname=%s\n", st->defdname);
	return n > 0 ? 0 : 1;
}

static int cmd_resq(const char *name)
{
	unsigned char buf[4096];
	long t0 = now_ms();
	int n;

	h_errno = 0;
	n = res_query(name, C_IN, T_A, buf, sizeof(buf));
	printf("probe=resq name=%s rc=%d ms=%ld h_errno=%d\n", name, n, now_ms() - t0, h_errno);
	if (n > 0) {
		char addrs[512] = "";
		int parsed;

		{
			int rcode = -1;
			parsed = parse_reply(buf, (size_t)n, ((unsigned)buf[0] << 8) | buf[1], &rcode, addrs,
					     sizeof(addrs));
		}
		printf("probe=resq_answers answers=%d addrs=%s\n", parsed < 0 ? 0 : parsed,
		       parsed < 0 ? "-" : addrs);
	}
	return n > 0 ? 0 : 1;
}
#endif

static void usage(void)
{
	fprintf(stderr,
		"usage: netprobe <command> [args]\n"
		"  iface\n"
		"  resolvconf\n"
		"  gai <name>\n"
		"  udp <ip> <port> <name> [timeout_ms]\n"
		"  tcp <ip> <port> [timeout_ms]\n"
#ifdef __GLIBC__
		"  res-state                what the C library resolver actually loaded\n"
		"  resq <name>              raw res_query() through libnss_dns/res_send\n"
#endif
		"version=1\n");
	exit(2);
}

int main(int argc, char **argv)
{
	long timeout = DEFAULT_TIMEOUT_MS;

	if (argc < 2)
		usage();
	if (argc >= 2 && strcmp(argv[1], "--version") == 0) {
		printf("version=1\n");
		return 0;
	}
	if (strcmp(argv[1], "iface") == 0)
		return cmd_iface();
	if (strcmp(argv[1], "resolvconf") == 0)
		return cmd_resolvconf();
	if (strcmp(argv[1], "gai") == 0 && argc >= 3)
		return cmd_gai(argv[2]);
	if (strcmp(argv[1], "udp") == 0 && argc >= 5) {
		if (argc >= 6)
			timeout = strtol(argv[5], NULL, 10);
		return cmd_udp(argv[2], argv[3], argv[4], timeout);
	}
	if (strcmp(argv[1], "tcp") == 0 && argc >= 4) {
		if (argc >= 5)
			timeout = strtol(argv[4], NULL, 10);
		return cmd_tcp(argv[2], argv[3], timeout);
	}
#ifdef __GLIBC__
	if (strcmp(argv[1], "res-state") == 0)
		return cmd_res_state();
	if (strcmp(argv[1], "resq") == 0 && argc >= 3)
		return cmd_resq(argv[2]);
#endif
	usage();
	return 2;
}
