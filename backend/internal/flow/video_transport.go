package flow

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"strings"
	"time"
)

const VideoMCPAudience = "weavesense-video-mcp"
const VideoMCPService = "weavesense-video-control"

// TrustedMCPService is deployment configuration, not a connection/user option.
// Every resolved address must be pinned; no CIDRs, proxy environment, redirects,
// arbitrary private targets, or TLS verification bypass are accepted.
type TrustedMCPService struct {
	Endpoint        string   `json:"endpoint"`
	ServiceIdentity string   `json:"service_identity"`
	Audience        string   `json:"audience"`
	Addresses       []string `json:"addresses"`
	AllowHTTP       bool     `json:"allow_http,omitempty"`
}

type mcpDelegateKey struct{}
type mcpDelegate struct {
	Scope Scope
	Actor Actor
}

func withMCPDelegate(ctx context.Context, scope Scope, actor Actor) context.Context {
	return context.WithValue(ctx, mcpDelegateKey{}, mcpDelegate{scope, actor})
}

func (g MCPGateway) trustedService(endpoint string) (*TrustedMCPService, error) {
	policies := g.TrustedServices
	if policies == nil {
		if raw := strings.TrimSpace(os.Getenv("FLOW_TRUSTED_VIDEO_MCP_SERVICES")); raw != "" {
			if json.Unmarshal([]byte(raw), &policies) != nil {
				return nil, errors.New("flow: invalid trusted MCP configuration")
			}
		}
	}
	for _, policy := range policies {
		if policy.Endpoint != endpoint {
			continue
		}
		u, err := url.Parse(policy.Endpoint)
		if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" ||
			!(u.Scheme == "https" || (u.Scheme == "http" && policy.AllowHTTP)) ||
			policy.Audience != VideoMCPAudience || policy.ServiceIdentity != VideoMCPService || len(policy.Addresses) == 0 {
			return nil, errors.New("flow: invalid trusted video service policy")
		}
		for _, addr := range policy.Addresses {
			ip, err := netip.ParseAddr(addr)
			if err != nil || ip.IsUnspecified() || ip.IsMulticast() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
				return nil, errors.New("flow: invalid trusted service address")
			}
		}
		return &policy, nil
	}
	return nil, nil
}

func trustedMCPTransport(policy TrustedMCPService) (*http.Transport, error) {
	u, err := url.Parse(policy.Endpoint)
	if err != nil {
		return nil, err
	}
	port := u.Port()
	if port == "" {
		if u.Scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	allowed := map[netip.Addr]bool{}
	for _, raw := range policy.Addresses {
		ip, err := netip.ParseAddr(raw)
		if err != nil {
			return nil, err
		}
		allowed[ip.Unmap()] = true
	}
	dial := &net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}
	tr := PublicTransport()
	tr.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		host, gotPort, err := net.SplitHostPort(address)
		if err != nil || host != u.Hostname() || gotPort != port {
			return nil, ErrEgressBlocked
		}
		ips, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
		if err != nil || len(ips) == 0 {
			return nil, fmt.Errorf("%w: service DNS unavailable", ErrEgressBlocked)
		}
		for _, ip := range ips {
			if !allowed[ip.Unmap()] {
				return nil, fmt.Errorf("%w: service DNS address not pinned", ErrEgressBlocked)
			}
		}
		// Dial the verified concrete address; do not resolve the hostname twice.
		return dial.DialContext(ctx, network, net.JoinHostPort(ips[0].String(), port))
	}
	return tr, nil
}

type trustedMCPRT struct {
	base                         http.RoundTripper
	endpoint, secret, delegation string
}

func (rt trustedMCPRT) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.URL.String() != rt.endpoint {
		return nil, ErrEgressBlocked
	}
	r := req.Clone(req.Context())
	if rt.secret != "" {
		r.Header.Set("Authorization", "Bearer "+rt.secret)
	}
	r.Header.Set("X-Flow-Context", rt.delegation)
	r.Header.Set("X-Flow-Service-Identity", VideoMCPService)
	return rt.base.RoundTrip(r)
}
