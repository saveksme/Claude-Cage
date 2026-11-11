package exitpolicy

import (
	"errors"
	"net/netip"
	"regexp"
	"strings"
	"time"
)

// Policy is user configuration. Its anchor survives checks and restarts;
// observations must never silently replace a configured address or region.
type Policy struct {
	Mode        string `json:"mode"`
	Scope       string `json:"scope"`
	IP          string `json:"ip,omitempty"`
	CountryCode string `json:"country_code,omitempty"`
	Region      string `json:"region,omitempty"`
	City        string `json:"city,omitempty"`
}

type Location struct {
	IP, CountryCode, Region, City string
	Country, RegionCode, Timezone string
	CheckedAt                     time.Time
}

type State string

const (
	Passed  State = "passed"
	Failed  State = "failed"
	Unknown State = "unknown"
)

func (p Policy) Normalized() Policy {
	if p.Mode == "" {
		p.Mode = "dynamic"
	}
	if p.Scope == "" {
		p.Scope = "country"
	}
	p.IP = strings.TrimSpace(p.IP)
	p.CountryCode = strings.ToUpper(strings.TrimSpace(p.CountryCode))
	p.Region = strings.Join(strings.Fields(p.Region), " ")
	p.City = strings.Join(strings.Fields(p.City), " ")
	return p
}

func (p Policy) Validate() error {
	p = p.Normalized()
	if p.Mode != "static" && p.Mode != "dynamic" {
		return errors.New("Выберите статический или динамический IP")
	}
	if p.Scope != "any" && p.Scope != "country" && p.Scope != "region" && p.Scope != "city" {
		return errors.New("Выберите разрешённый диапазон для динамического IP")
	}
	if p.IP != "" {
		ip, err := netip.ParseAddr(p.IP)
		if err != nil || !ip.Is4() || !ip.IsGlobalUnicast() || ip.IsPrivate() {
			return errors.New("Для фиксированного выхода укажите публичный IPv4-адрес")
		}
	}
	if p.CountryCode != "" && !regexp.MustCompile(`^[A-Z]{2}$`).MatchString(p.CountryCode) {
		return errors.New("Код страны или региона должен состоять из двух букв, например US")
	}
	if len(p.Region) > 120 || len(p.City) > 120 {
		return errors.New("Название региона слишком длинное")
	}
	return nil
}

func (p Policy) NeedsBinding() bool {
	p = p.Normalized()
	if p.Mode == "static" {
		return p.IP == ""
	}
	return p.Scope != "any" && (p.CountryCode == "" || (p.Scope == "region" || p.Scope == "city") && p.Region == "" || p.Scope == "city" && p.City == "")
}

// BindMissing is used only for a previously unconfigured anchor. It leaves
// existing values intact, including when the new observation violates them.
func (p Policy) BindMissing(location Location) Policy {
	p = p.Normalized()
	if state, _ := CheckExitCountry(location.IP, &location); state != Passed {
		return p
	}
	if p.Mode == "static" && p.IP == "" {
		p.IP = location.IP
	}
	if p.Mode == "dynamic" && p.Scope != "any" {
		if p.CountryCode == "" {
			p.CountryCode = location.CountryCode
		}
		if (p.Scope == "region" || p.Scope == "city") && strings.EqualFold(p.CountryCode, location.CountryCode) {
			if p.Region == "" {
				p.Region = location.Region
			}
			if p.Scope == "city" && p.City == "" {
				p.City = location.City
			}
		}
	}
	return p.Normalized()
}

func (p Policy) Evaluate(ip string, location *Location) (State, string) {
	p = p.Normalized()
	if err := p.Validate(); err != nil {
		return Unknown, err.Error()
	}
	if state, message := CheckExitCountry(ip, location); state != Passed {
		return state, message
	}
	if p.NeedsBinding() {
		if p.Mode == "dynamic" && p.CountryCode == "" {
			return Unknown, "Разрешённая страна или регион для динамического IP ещё не привязаны; внешняя сеть остаётся отключённой. Укажите регион выхода в настройках сети и прокси"
		}
		return Unknown, "Правило выхода ещё не привязано; подтвердите обнаруженный IP или регион в настройках"
	}
	if p.Mode == "static" {
		if p.IP != ip {
			return Failed, "Проверяемый выход отличается от привязанного статического IP"
		}
		return Passed, "Проверяемый выход совпадает с привязанным статическим IP"
	}
	if p.Scope == "any" {
		return Passed, "Динамический IP может меняться за пределами материкового Китая; трафик по-прежнему должен идти через указанный прокси"
	}
	if !strings.EqualFold(p.CountryCode, location.CountryCode) {
		return Failed, "Проверяемый выход за пределами разрешённой страны или региона"
	}
	if p.Scope == "country" {
		return Passed, "Проверяемый выход находится в разрешённой стране или регионе"
	}
	if location.Region == "" {
		return Unknown, "В текущем местоположении отсутствует штат или провинция; подтвердить разрешённый диапазон невозможно"
	}
	if !strings.EqualFold(p.Region, strings.Join(strings.Fields(location.Region), " ")) {
		return Failed, "Проверяемый выход за пределами разрешённых штатов или провинций"
	}
	if p.Scope == "region" {
		return Passed, "Проверяемый выход находится в разрешённом штате или провинции"
	}
	if location.City == "" {
		return Unknown, "В текущем местоположении отсутствует штат, провинция или город; подтвердить городской диапазон невозможно"
	}
	if !strings.EqualFold(p.City, strings.Join(strings.Fields(location.City), " ")) {
		return Failed, "Проверяемый выход за пределами разрешённых городов"
	}
	return Passed, "Проверяемый выход находится в разрешённом городе и его штате или провинции"
}
