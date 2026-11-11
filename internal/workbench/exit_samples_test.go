package workbench

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestIncompleteExitSamplesIdentifyRoutesAndRedactPrivateErrors(t *testing.T) {
	good := networkObservation{Status: 200, IP: "8.8.8.8"}
	message := incompleteExitSamples("", context.DeadlineExceeded, good, nil, networkObservation{}, errors.New("浏览器请求失败 https://user:password@private.example/secret token=private-token /Users/alice/project"))
	for _, want := range []string{"Хост", "истекло время ожидания", "Браузер", "Выборка выхода неполна"} {
		if !strings.Contains(message, want) {
			t.Fatalf("missing diagnostic %q: %s", want, message)
		}
	}
	for _, unwanted := range []string{"Терминал виртуальной машины", "private.example", "private-token", "alice", "password"} {
		if strings.Contains(message, unwanted) {
			t.Fatalf("successful route or private data included: %s", message)
		}
	}
	if message := incompleteExitSamples("8.8.8.8", nil, good, nil, good, nil); message != "" {
		t.Fatal("complete samples reported missing", message)
	}
	for _, tc := range []struct {
		observation networkObservation
		want        string
	}{
		{networkObservation{}, "Ответ канала проверки не получен"},
		{networkObservation{Status: 503}, "HTTP 503"},
		{networkObservation{Status: 200}, "не вернул адрес выхода"},
	} {
		message := incompleteExitSamples("8.8.8.8", nil, tc.observation, nil, good, nil)
		if !strings.Contains(message, "Терминал виртуальной машины: ") || !strings.Contains(message, tc.want) || strings.Contains(message, "Хост: ") || strings.Contains(message, "Браузер: ") {
			t.Fatalf("wrong route or failure category: %s", message)
		}
	}
}
