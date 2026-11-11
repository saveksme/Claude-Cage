package managedproxy

import (
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/miekg/dns"
	"github.com/sylvinus/agent-vm/internal/hostproxy"
)

// BootstrapClient serves only explicitly host-routed subscription requests.
func BootstrapClient() *http.Client {
	return &http.Client{Transport: subscriptionHostTransport{hostproxy.NewTransport(), BootstrapDNSURLs()}, Timeout: 30 * time.Second, CheckRedirect: func(r *http.Request, via []*http.Request) error {
		if len(via) >= 3 || r.URL.Scheme != "https" || r.URL.User != nil {
			return errors.New("Перенаправление подписки отклонено")
		}
		return nil
	}}
}

type subscriptionHostTransport struct {
	host      *http.Transport
	resolvers []string
}

func (t subscriptionHostTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	// Resolve routing for the original hostname (including on redirects).
	// Pin both DoH and the subscription transfer to the selected route.
	routing := req.Clone(req.Context())
	routing.URL.Path, routing.URL.RawPath, routing.URL.RawQuery = "", "", ""
	route, err := t.host.Proxy(routing)
	if err != nil {
		return nil, err
	}
	tr := t.host.Clone()
	tr.Proxy = http.ProxyURL(route)
	tr.DisableKeepAlives = true
	host := req.URL.Hostname()
	ip, err := netip.ParseAddr(host)
	if err != nil {
		dnsClient := &http.Client{Transport: tr, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("DNS redirect refused") }}
		ip, err = resolveInfrastructureWith(req.Context(), host, dnsClient, t.resolvers)
		if err != nil {
			return nil, err
		}
	}
	if !publicIP(ip) {
		return nil, errors.New("Сервер подписки должен использовать публичный адрес")
	}

	// CONNECT (or SOCKS) must address the validated IP, while HTTP Host and
	// TLS SNI/certificate checks still use the subscription's original name.
	// DoH requests may still be finishing, so configure a separate transport.
	target := tr.Clone()
	if target.TLSClientConfig == nil {
		target.TLSClientConfig = &tls.Config{}
	}
	if route != nil && route.Scheme == "https" {
		// The outer TLS handshake authenticates the proxy, independently of
		// the inner TLS session established through its CONNECT tunnel.
		outer := target.TLSClientConfig.Clone()
		outer.ServerName, outer.NextProtos = route.Hostname(), []string{"http/1.1"}
		target.DialTLSContext = (&tls.Dialer{Config: outer, NetDialer: &net.Dialer{Timeout: 10 * time.Second}}).DialContext
	}
	target.TLSClientConfig.ServerName = host
	pinned := req.Clone(req.Context())
	pinned.Host = req.URL.Host
	pinned.URL.Host = ip.String()
	if port := req.URL.Port(); port != "" {
		pinned.URL.Host = net.JoinHostPort(ip.String(), port)
	}
	return target.RoundTrip(pinned)
}

func usageSummary(raw string) string {
	parts := []string{}
	for _, field := range strings.Split(raw, ";") {
		kv := strings.SplitN(strings.TrimSpace(field), "=", 2)
		if len(kv) != 2 {
			continue
		}
		if kv[0] != "upload" && kv[0] != "download" && kv[0] != "total" && kv[0] != "expire" {
			continue
		}
		if _, err := strconv.ParseUint(kv[1], 10, 64); err == nil {
			parts = append(parts, kv[0]+"="+kv[1])
		}
	}
	return strings.Join(parts, "; ")
}
func publicIP(ip netip.Addr) bool {
	return ip.Is4() && ip.IsGlobalUnicast() && !ip.IsPrivate() && !ip.IsLoopback() && !ip.IsLinkLocalUnicast() && !netip.MustParsePrefix("100.64.0.0/10").Contains(ip) && !netip.MustParsePrefix("198.18.0.0/15").Contains(ip)
}

// BootstrapDNSURLs is shared by host downloads and the core's node resolver.
// Numeric HTTPS endpoints need neither the host resolver nor a working proxy.
func BootstrapDNSURLs() []string {
	return []string{"https://1.1.1.1/dns-query", "https://223.5.5.5/dns-query"}
}

func resolveInfrastructureWith(ctx context.Context, host string, client *http.Client, servers []string) (netip.Addr, error) {
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	q := new(dns.Msg)
	q.SetQuestion(dns.Fqdn(host), dns.TypeA)
	wire, err := q.Pack()
	if err != nil {
		return netip.Addr{}, errors.New("Недопустимое доменное имя инфраструктуры прокси")
	}
	type result struct {
		ip  netip.Addr
		err error
	}
	results := make(chan result, len(servers))
	// A blocked resolver must not delay a reachable one. Cancel the remaining
	// HTTPS requests once a usable public answer is available.
	for _, server := range servers {
		go func() {
			ip, err := queryInfrastructureDNS(ctx, client, server, q, wire)
			results <- result{ip, err}
		}()
	}
	for range servers {
		select {
		case <-ctx.Done():
			return netip.Addr{}, ctx.Err()
		case result := <-results:
			if result.err == nil {
				return result.ip, nil
			}
		}
	}
	return netip.Addr{}, errors.New("Все DNS инфраструктуры прокси недоступны или не вернули публичный IPv4; проверьте сеть хоста и повторите попытку; системный DNS не использовался как запасной вариант")
}

func queryInfrastructureDNS(ctx context.Context, client *http.Client, server string, q *dns.Msg, wire []byte) (netip.Addr, error) {
	req, err := http.NewRequestWithContext(ctx, "POST", server, bytes.NewReader(wire))
	if err != nil {
		return netip.Addr{}, err
	}
	req.Header.Set("Content-Type", "application/dns-message")
	req.Header.Set("Accept", "application/dns-message")
	resp, err := client.Do(req)
	if err != nil {
		return netip.Addr{}, errors.New("Не удалось разрешить доменное имя инфраструктуры прокси")
	}
	defer resp.Body.Close()
	wire, err = io.ReadAll(io.LimitReader(resp.Body, 65536))
	var answer dns.Msg
	if err != nil || resp.StatusCode != 200 || answer.Unpack(wire) != nil || answer.Id != q.Id ||
		!answer.Response || answer.Truncated || answer.Rcode != dns.RcodeSuccess || len(answer.Question) != 1 ||
		!strings.EqualFold(answer.Question[0].Name, q.Question[0].Name) || answer.Question[0].Qtype != dns.TypeA || answer.Question[0].Qclass != dns.ClassINET {
		return netip.Addr{}, errors.New("Недопустимый DNS-ответ инфраструктуры прокси")
	}
	for _, rr := range answer.Answer {
		if a, ok := rr.(*dns.A); ok {
			if ip, ok := netip.AddrFromSlice(a.A); ok && publicIP(ip.Unmap()) {
				return ip.Unmap(), nil
			}
		}
	}
	return netip.Addr{}, errors.New("У домена инфраструктуры прокси нет доступного публичного IPv4")
}
func Fetch(ctx context.Context, client *http.Client, rawURL string) ([]byte, string, error) {
	u, err := url.Parse(rawURL)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.Fragment != "" {
		return nil, "", errors.New("Для подписки нужен полный URL HTTPS; имя пользователя и пароль в адресе не поддерживаются")
	}
	req, err := http.NewRequestWithContext(ctx, "GET", u.String(), nil)
	if err != nil {
		return nil, "", errors.New("Недопустимый URL подписки")
	}
	req.Header.Set("User-Agent", "clash.meta/Cage")
	res, err := client.Do(req)
	if err != nil {
		return nil, "", errors.New("Не удалось скачать подписку; проверьте путь загрузки и адрес службы")
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, "", errors.New("Сервер подписки вернул HTTP " + strconv.Itoa(res.StatusCode))
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, MaxImport+1))
	if err != nil || len(b) > MaxImport {
		return nil, "", errors.New("Загрузка подписки прервана или превышает 8 MiB")
	}
	usage := "" // Keep only known numeric metadata; never echo arbitrary headers.
	if raw := res.Header.Get("Subscription-Userinfo"); len(raw) < 300 {
		usage = usageSummary(raw)
	}
	return b, usage, nil
}
