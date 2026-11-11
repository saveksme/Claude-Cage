package exitpolicy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
	_ "time/tzdata"
)

// Lookup queries both providers as needed for the measured address.
// The caller supplies the shared proxy-only client, including for fallback.
func Lookup(ctx context.Context, client *http.Client, address net.IP) (Location, error) {
	providers := []struct{ name, url string }{
		{"ipwho.is", "https://ipwho.is/" + address.String() + "?fields=success,ip,country,country_code,region,region_code,city,timezone.id"},
		{"IP.SB", "https://api.ip.sb/geoip/" + address.String()},
	}
	failures := make([]string, 0, len(providers))
	for _, provider := range providers {
		if err := ctx.Err(); err != nil {
			return Location{}, err
		}
		loc, err := queryLocation(ctx, client, provider.url, provider.name == "ipwho.is", address)
		if err == nil {
			return loc, nil
		}
		// Only our own summaries reach the UI; transport errors may contain
		// local network details and provider bodies are untrusted text.
		failures = append(failures, provider.name+": "+err.Error())
	}
	if err := ctx.Err(); err != nil {
		return Location{}, err
	}
	return Location{}, fmt.Errorf("IP-адрес выхода получен, но все запросы местоположения не удались (%s). Повторите попытку или смените узел. Прямое подключение не использовалось", strings.Join(failures, "; "))
}

func queryLocation(ctx context.Context, client *http.Client, endpoint string, requireSuccess bool, address net.IP) (Location, error) {
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return Location{}, errors.New("Недопустимый адрес запроса")
	}
	req.Header.Set("User-Agent", "Cage-network-check/1")
	r, err := client.Do(req)
	if err != nil {
		return Location{}, errors.New("Соединение не удалось или истекло время ожидания")
	}
	defer r.Body.Close()
	if r.StatusCode != http.StatusOK {
		return Location{}, fmt.Errorf("HTTP %d", r.StatusCode)
	}
	var v struct {
		Success     *bool           `json:"success"`
		IP          string          `json:"ip"`
		Country     string          `json:"country"`
		CountryCode string          `json:"country_code"`
		Region      string          `json:"region"`
		RegionCode  string          `json:"region_code"`
		City        string          `json:"city"`
		Timezone    json.RawMessage `json:"timezone"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 128<<10)).Decode(&v) != nil ||
		(requireSuccess && (v.Success == nil || !*v.Success)) ||
		net.ParseIP(v.IP) == nil || !net.ParseIP(v.IP).Equal(address) {
		return Location{}, errors.New("Недопустимый ответ или несовпадение IP")
	}
	country := strings.ToUpper(strings.TrimSpace(v.CountryCode))
	if len(country) != 2 || country[0] < 'A' || country[0] > 'Z' || country[1] < 'A' || country[1] > 'Z' {
		return Location{}, errors.New("Отсутствует действительная страна или регион")
	}
	var timezone string
	if requireSuccess {
		var zone struct {
			ID string `json:"id"`
		}
		if json.Unmarshal(v.Timezone, &zone) == nil {
			timezone = zone.ID
		}
	} else {
		_ = json.Unmarshal(v.Timezone, &timezone)
	}
	if timezone == "" || timezone == "Local" {
		return Location{}, errors.New("Отсутствует действительный часовой пояс")
	}
	if _, err = time.LoadLocation(timezone); err != nil {
		return Location{}, errors.New("Отсутствует действительный часовой пояс")
	}
	return Location{IP: address.String(), Country: v.Country, CountryCode: country, Region: v.Region, RegionCode: v.RegionCode, City: v.City, Timezone: timezone, CheckedAt: time.Now()}, nil
}
