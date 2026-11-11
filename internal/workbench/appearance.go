package workbench

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/pelletier/go-toml/v2"
)

type AppearanceFonts struct {
	UI   string `json:"ui" toml:"ui"`
	Code string `json:"code" toml:"code"`
}
type AppearanceTheme struct {
	Preset        string            `json:"preset"`
	Accent        string            `json:"accent" toml:"accent"`
	Surface       string            `json:"surface" toml:"surface"`
	Ink           string            `json:"ink" toml:"ink"`
	Contrast      int               `json:"contrast" toml:"contrast"`
	OpaqueWindows bool              `json:"opaqueWindows" toml:"opaqueWindows"`
	Fonts         AppearanceFonts   `json:"fonts" toml:"fonts"`
	Colors        map[string]string `json:"colors,omitempty"`
	Terminal      map[string]string `json:"terminal,omitempty"`
}
type SavedAppearanceTheme struct {
	ID    string          `json:"id"`
	Name  string          `json:"name"`
	Light AppearanceTheme `json:"lightTheme"`
	Dark  AppearanceTheme `json:"darkTheme"`
}
type Appearance struct {
	CustomThemes   []SavedAppearanceTheme `json:"customThemes,omitempty"`
	Mode           string                 `json:"mode"`
	Light          AppearanceTheme        `json:"lightTheme"`
	Dark           AppearanceTheme        `json:"darkTheme"`
	UIFontSize     int                    `json:"uiFontSize"`
	CodeFontSize   int                    `json:"codeFontSize"`
	PointerCursors bool                   `json:"pointerCursors"`
	FontSmoothing  bool                   `json:"fontSmoothing"`
	ReducedMotion  string                 `json:"reducedMotion"`
}

func defaultAppearance() Appearance {
	return Appearance{Mode: "system", Light: AppearanceTheme{Preset: "codex", Accent: "#339cff", Surface: "#ffffff", Ink: "#1a1c1f", Contrast: 45}, Dark: AppearanceTheme{Preset: "codex", Accent: "#339cff", Surface: "#181818", Ink: "#ffffff", Contrast: 60}, UIFontSize: 14, CodeFontSize: 13, FontSmoothing: true, ReducedMotion: "system"}
}

func (a Appearance) validate() error {
	if a.Mode != "system" && a.Mode != "light" && a.Mode != "dark" {
		return errors.New("Выберите оформление «как в системе», светлое или тёмное")
	}
	if a.UIFontSize < 12 || a.UIFontSize > 24 || a.CodeFontSize < 10 || a.CodeFontSize > 24 {
		return errors.New("Размер шрифта интерфейса — от 12 до 24, кода — от 10 до 24")
	}
	if a.ReducedMotion != "system" && a.ReducedMotion != "on" && a.ReducedMotion != "off" {
		return errors.New("Неверный параметр уменьшения анимации")
	}
	if err := validateAppearanceTheme(a.Light); err != nil {
		return err
	}
	if err := validateAppearanceTheme(a.Dark); err != nil {
		return err
	}
	if len(a.CustomThemes) > 50 {
		return errors.New("Можно сохранить не более 50 пользовательских тем; сначала удалите ненужные")
	}
	ids := make(map[string]bool)
	for _, saved := range a.CustomThemes {
		if !regexp.MustCompile(`^[a-zA-Z0-9_-]{1,80}$`).MatchString(saved.ID) || ids[saved.ID] {
			return errors.New("Неверный или повторяющийся идентификатор пользовательской темы")
		}
		ids[saved.ID] = true
		if strings.TrimSpace(saved.Name) == "" || utf8.RuneCountInString(saved.Name) > 80 {
			return errors.New("Введите название темы длиной от 1 до 80 символов")
		}
		if err := validateAppearanceTheme(saved.Light); err != nil {
			return err
		}
		if err := validateAppearanceTheme(saved.Dark); err != nil {
			return err
		}
	}
	return nil
}

var appearanceColorKeys = strings.Fields("sidebar sidebarInk toolbar toolbarInk chrome chromeDark strong muted line input button buttonInk accentInk link focus hover selected selection success warning danger inactive")
var terminalColorKeys = strings.Fields("background foreground cursor cursorAccent selectionBackground black red green yellow blue magenta cyan white brightBlack brightRed brightGreen brightYellow brightBlue brightMagenta brightCyan brightWhite")
var appearanceColor = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

func validateAppearanceTheme(theme AppearanceTheme) error {
	if !appearanceColor.MatchString(theme.Accent) || !appearanceColor.MatchString(theme.Surface) || !appearanceColor.MatchString(theme.Ink) {
		return errors.New("Цвет должен быть шестизначным шестнадцатеричным значением, например #fdf6e3")
	}
	if theme.Contrast < 0 || theme.Contrast > 100 {
		return errors.New("Контрастность — от 0 до 100")
	}
	if utf8.RuneCountInString(theme.Preset) > 80 {
		return errors.New("Название темы слишком длинное")
	}
	for _, font := range []string{theme.Fonts.UI, theme.Fonts.Code} {
		if utf8.RuneCountInString(font) > 200 || strings.ContainsAny(font, ";{}<>\r\n") {
			return errors.New("Неверное название шрифта")
		}
	}
	for field, colors := range map[string]map[string]string{"colors": theme.Colors, "terminal": theme.Terminal} {
		allowed := appearanceColorKeys
		if field == "terminal" {
			allowed = terminalColorKeys
		}
		for key, value := range colors {
			found := false
			for _, candidate := range allowed {
				if key == candidate {
					found = true
					break
				}
			}
			if !found || !appearanceColor.MatchString(value) {
				return errors.New("Неверный цвет элемента или наличие неподдерживаемых цветовых элементов")
			}
		}
	}
	return nil
}

func (s *Server) getAppearance(w http.ResponseWriter, r *http.Request) {
	a := defaultAppearance()
	b, err := os.ReadFile(filepath.Join(s.profile, "appearance.json"))
	if err == nil {
		err = json.Unmarshal(b, &a)
	}
	if err != nil && !os.IsNotExist(err) {
		requestError(w, errors.New("Не удалось прочитать сохранённые настройки оформления"))
		return
	}
	if err = a.validate(); err != nil {
		requestError(w, err)
		return
	}
	jsonReply(w, a)
}

func (s *Server) saveAppearance(w http.ResponseWriter, r *http.Request) {
	var a Appearance
	if !readJSON(w, r, &a, 512<<10) {
		return
	}
	if err := a.validate(); err != nil {
		requestError(w, err)
		return
	}
	// Appearance has no VM or network side effects and uses its own atomic file.
	if err := writePrivate(filepath.Join(s.profile, "appearance.json"), a); err != nil {
		requestError(w, errors.New("Не удалось сохранить настройки оформления; повторите попытку"))
		return
	}
	jsonReply(w, a)
}

func readCodexAppearance(configPath string) (Appearance, error) {
	a := defaultAppearance()
	a.CodeFontSize = 12
	var config struct {
		Desktop struct {
			Mode           string           `toml:"appearanceTheme"`
			Light          *AppearanceTheme `toml:"appearanceLightChromeTheme"`
			Dark           *AppearanceTheme `toml:"appearanceDarkChromeTheme"`
			LightPreset    string           `toml:"appearanceLightCodeThemeId"`
			DarkPreset     string           `toml:"appearanceDarkCodeThemeId"`
			UIFontSize     int              `toml:"sansFontSize"`
			CodeFontSize   int              `toml:"codeFontSize"`
			PointerCursors bool             `toml:"usePointerCursors"`
			FontSmoothing  *bool            `toml:"useFontSmoothing"`
		} `toml:"desktop"`
	}
	b, err := os.ReadFile(configPath)
	if err != nil {
		return a, errors.New("Не найдена локальная конфигурация Codex")
	}
	if err = toml.Unmarshal(b, &config); err != nil {
		return a, errors.New("Не удалось разобрать локальную конфигурацию Codex")
	}
	d := config.Desktop
	if d.Mode != "" {
		a.Mode = d.Mode
	}
	if d.Light != nil {
		a.Light = *d.Light
	}
	if d.Dark != nil {
		a.Dark = *d.Dark
	}
	a.Light.Preset = d.LightPreset
	if a.Light.Preset == "" {
		a.Light.Preset = "codex"
	}
	a.Dark.Preset = d.DarkPreset
	if a.Dark.Preset == "" {
		a.Dark.Preset = "codex"
	}
	if d.UIFontSize != 0 {
		a.UIFontSize = d.UIFontSize
	}
	if d.CodeFontSize != 0 {
		a.CodeFontSize = d.CodeFontSize
	}
	a.PointerCursors = d.PointerCursors
	if d.FontSmoothing != nil {
		a.FontSmoothing = *d.FontSmoothing
	}
	// This preference is stored separately by Codex; no other state is returned.
	var global struct {
		ReducedMotion string `json:"reduced-motion-preference"`
	}
	if b, err := os.ReadFile(filepath.Join(filepath.Dir(configPath), ".codex-global-state.json")); err == nil && json.Unmarshal(b, &global) == nil && global.ReducedMotion != "" {
		a.ReducedMotion = global.ReducedMotion
	}
	return a, a.validate()
}

func (s *Server) codexAppearance(w http.ResponseWriter, r *http.Request) {
	home, err := os.UserHomeDir()
	if err != nil {
		requestError(w, errors.New("Не удалось определить домашний каталог пользователя"))
		return
	}
	a, err := readCodexAppearance(filepath.Join(home, ".codex", "config.toml"))
	if err != nil {
		requestError(w, err)
		return
	}
	jsonReply(w, a)
}
