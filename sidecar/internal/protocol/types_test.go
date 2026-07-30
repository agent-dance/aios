package protocol

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func ptr[T any](value T) *T { return &value }

func TestChatRequestRequiresRevisionAndRejectsUnknownFields(t *testing.T) {
	req := ChatRequest{RequestID: "request-1", ThreadID: "thread-1", Message: "hello", History: []ChatHistoryEntry{{Role: "user", Content: "previous question"}, {Role: "assistant", Content: "previous answer"}}, Context: ChatContext{OSRevision: ptr[int64](0)}}
	if err := req.Validate(); err != nil {
		t.Fatal(err)
	}
	req.History[0].Role = "system"
	if err := req.Validate(); err == nil {
		t.Fatal("system role accepted in bounded conversation history")
	}
	req.History[0].Role = "user"
	req.Context.OSRevision = nil
	if err := req.Validate(); err == nil {
		t.Fatal("missing revision accepted")
	}
	var decoded ChatRequest
	if err := DecodeStrict([]byte(`{"requestId":"r","threadId":"t","message":"m","context":{"osRevision":0},"extra":true}`), &decoded); err == nil {
		t.Fatal("unknown property accepted")
	}
	if err := DecodeStrict([]byte(`{"requestId":"r","threadId":"t","message":"m","context":{"osRevision":0}} trailing`), &decoded); err == nil {
		t.Fatal("trailing non-JSON data accepted")
	}
}

func TestChatContextValidatesBoundedStatusGamesAndEnabledDomainAgents(t *testing.T) {
	enabledAgent := EnabledAgent{ID: "travel.planner", Name: "Travel", Description: "Plans trips", Instructions: "Use current public context only.", Capabilities: []string{"os.app.open"}, Contributions: []string{"domain-agent"}}
	status := &SystemStatus{
		WifiEnabled: ptr(true), WifiLabel: "AlSniper Mesh",
		BluetoothEnabled: ptr(false), BluetoothLabel: "Offline",
		HealthScore: ptr(98), StorageUsedGB: ptr(64.5), StorageTotalGB: ptr(128.0),
		EnergyMode: "Balanced", Brightness: ptr(72), Volume: ptr(38),
	}
	req := ChatRequest{RequestID: "request-1", ThreadID: "thread-1", Message: "plan", Context: ChatContext{
		OSRevision: ptr[int64](3), SystemStatus: status, RunningGameIDs: []string{"match-1"}, EnabledAgents: []EnabledAgent{enabledAgent},
	}}
	if err := req.Validate(); err != nil {
		t.Fatal(err)
	}
	req.Context.RunningGameIDs = []string{"match-1", "match-1"}
	if err := req.Validate(); err == nil {
		t.Fatal("duplicate runningGameIds accepted")
	}
	req.Context.RunningGameIDs = nil
	*status.HealthScore = 101
	if err := req.Validate(); err == nil {
		t.Fatal("out-of-range system status accepted")
	}
	*status.HealthScore = 98
	enabledAgent.Contributions = []string{"game-controller"}
	req.Context.EnabledAgents = []EnabledAgent{enabledAgent}
	if err := req.Validate(); err == nil {
		t.Fatal("non-domain enabled Agent accepted")
	}
}

func TestSystemStatusIntentIsClosedAndPreferencesAccentMatchesBrowser(t *testing.T) {
	brightness := 50
	intent := Intent{ID: "status-1", Type: "set_system_status", StatusPatch: &SystemStatusPatch{Brightness: &brightness}}
	if err := intent.Validate(); err != nil {
		t.Fatal(err)
	}
	emptyStatus := Intent{ID: "status-1", Type: "set_system_status", StatusPatch: &SystemStatusPatch{}}
	if err := emptyStatus.Validate(); err == nil {
		t.Fatal("empty status patch accepted")
	}
	var output AgentOutput
	if err := DecodeStrict([]byte(`{"message":"ok","mood":"neutral","intents":[{"id":"status-1","type":"set_system_status","statusPatch":{"healthScore":100}}]}`), &output); err == nil {
		t.Fatal("read-only telemetry field accepted in statusPatch")
	}
	for _, accent := range []string{"lime", "cyan", "amber"} {
		if err := (Preferences{Accent: ptr(accent)}).Validate(); err != nil {
			t.Fatalf("accent %q rejected: %v", accent, err)
		}
	}
	legacy := "#c9ff57"
	if err := (Preferences{Accent: &legacy}).Validate(); err == nil {
		t.Fatal("legacy color accent accepted")
	}
}

func TestExecuteApplicationActionValidatesKnownWeChatArguments(t *testing.T) {
	valid := Intent{
		ID: "send-1", Type: "execute_app_action", AppID: "wechat",
		ActionID: wechatSendToCurrentActionID, Arguments: json.RawMessage(`{"text":"hello"}`),
	}
	if err := valid.Validate(); err != nil {
		t.Fatalf("valid WeChat action rejected: %v", err)
	}
	valid.Arguments = json.RawMessage(`{"text":"emoji \ud83d\ude00 preserved"}`)
	if err := valid.Validate(); err != nil {
		t.Fatalf("valid JSON surrogate pair rejected: %v", err)
	}
	var paired WeChatSendToCurrentArguments
	if err := DecodeStrict(valid.Arguments, &paired); err != nil {
		t.Fatal(err)
	}
	if paired.Text != "emoji 😀 preserved" || strings.ContainsRune(paired.Text, '\ufffd') {
		t.Fatalf("valid surrogate pair was corrupted: %q", paired.Text)
	}
	valid.Arguments = json.RawMessage(`{"text":"literal \\ud83d and \\ude00 escapes"}`)
	if err := valid.Validate(); err != nil {
		t.Fatalf("escaped literal surrogate spelling rejected: %v", err)
	}
	valid.Arguments = json.RawMessage(`{"text":"line 1\r\nline 2\rline 3"}`)
	if err := valid.Validate(); err != nil {
		t.Fatalf("WeChat newline normalization rejected: %v", err)
	}
	var normalized WeChatSendToCurrentArguments
	if err := DecodeStrict(valid.Arguments, &normalized); err != nil {
		t.Fatal(err)
	}
	if normalized.Text != "line 1\nline 2\nline 3" {
		t.Fatalf("WeChat newlines were not normalized: %q", normalized.Text)
	}
	valid.Arguments = json.RawMessage(fmt.Sprintf(`{"text":%q}`, strings.Repeat("a\r\n", 2000)))
	if err := valid.Validate(); err != nil {
		t.Fatalf("text reaching 4000 UTF-16 units only after CRLF normalization rejected: %v", err)
	}
	valid.Arguments = json.RawMessage(fmt.Sprintf(`{"text":%q}`, strings.Repeat("😀", 2000)))
	if err := valid.Validate(); err != nil {
		t.Fatalf("4000 UTF-16-unit WeChat message rejected: %v", err)
	}
	valid.Arguments = json.RawMessage(fmt.Sprintf(`{"text":%q}`, strings.Repeat("😀", 2000)+"a"))
	if err := valid.Validate(); err == nil {
		t.Fatal("WeChat message beyond 4000 UTF-16 units accepted")
	}
	valid.Arguments = json.RawMessage(strings.Repeat(" ", maxApplicationActionArgumentsBytes) + `{"text":"hello"}`)
	if err := valid.Validate(); err == nil {
		t.Fatal("WeChat arguments beyond 64 KiB serialized JSON accepted before normalization")
	}

	rejected := []struct {
		name      string
		appID     string
		actionID  string
		arguments string
	}{
		{name: "wrong app", appID: "settings", actionID: wechatSendToCurrentActionID, arguments: `{"text":"hello"}`},
		{name: "missing text", appID: "wechat", actionID: wechatSendToCurrentActionID, arguments: `{}`},
		{name: "empty text", appID: "wechat", actionID: wechatSendToCurrentActionID, arguments: `{"text":""}`},
		{name: "blank text", appID: "wechat", actionID: wechatSendToCurrentActionID, arguments: `{"text":" \r\n\t"}`},
		{name: "BOM-only text", appID: "wechat", actionID: wechatSendToCurrentActionID, arguments: `{"text":"\ufeff"}`},
		{name: "NUL text", appID: "wechat", actionID: wechatSendToCurrentActionID, arguments: `{"text":"hello\u0000world"}`},
		{name: "C0 control", appID: "wechat", actionID: wechatSendToCurrentActionID, arguments: `{"text":"hello\u0007world"}`},
		{name: "tab control", appID: "wechat", actionID: wechatSendToCurrentActionID, arguments: `{"text":"hello\tworld"}`},
		{name: "C1 control", appID: "wechat", actionID: wechatSendToCurrentActionID, arguments: `{"text":"hello\u009fworld"}`},
		{name: "Arabic letter mark", appID: "wechat", actionID: wechatSendToCurrentActionID, arguments: `{"text":"hello\u061cworld"}`},
		{name: "left-to-right mark", appID: "wechat", actionID: wechatSendToCurrentActionID, arguments: `{"text":"hello\u200eworld"}`},
		{name: "line separator", appID: "wechat", actionID: wechatSendToCurrentActionID, arguments: `{"text":"hello\u2028world"}`},
		{name: "bidi override", appID: "wechat", actionID: wechatSendToCurrentActionID, arguments: `{"text":"hello\u202eworld"}`},
		{name: "bidi isolate", appID: "wechat", actionID: wechatSendToCurrentActionID, arguments: `{"text":"hello\u2066world"}`},
		{name: "lone high surrogate", appID: "wechat", actionID: wechatSendToCurrentActionID, arguments: `{"text":"hello\ud83d"}`},
		{name: "lone low surrogate", appID: "wechat", actionID: wechatSendToCurrentActionID, arguments: `{"text":"hello\ude00"}`},
		{name: "high followed by non-low", appID: "wechat", actionID: wechatSendToCurrentActionID, arguments: `{"text":"hello\ud83d\u0041"}`},
		{name: "unknown field", appID: "wechat", actionID: wechatSendToCurrentActionID, arguments: `{"text":"hello","recipient":"someone"}`},
		{name: "duplicate field", appID: "wechat", actionID: wechatSendToCurrentActionID, arguments: `{"text":"first","text":"second"}`},
		{name: "non-object", appID: "wechat", actionID: wechatSendToCurrentActionID, arguments: `[]`},
		{name: "invalid action id", appID: "wechat", actionID: "WeChat.send", arguments: `{}`},
		{name: "invalid app id", appID: "WeChat", actionID: "future.action", arguments: `{}`},
	}
	for _, test := range rejected {
		t.Run(test.name, func(t *testing.T) {
			intent := Intent{ID: "send-1", Type: "execute_app_action", AppID: test.appID, ActionID: test.actionID, Arguments: json.RawMessage(test.arguments)}
			if err := intent.Validate(); err == nil {
				t.Fatal("invalid application action accepted")
			}
		})
	}
}

func TestExecuteApplicationActionSupportsBoundedExtensibleArguments(t *testing.T) {
	intent := Intent{
		ID: "future-1", Type: "execute_app_action", AppID: "calendar",
		ActionID: "calendar.event.create", Arguments: json.RawMessage(`{"title":"Review","metadata":{"priority":2},"attendees":["a","b"]}`),
	}
	if err := intent.Validate(); err != nil {
		t.Fatalf("bounded future action rejected: %v", err)
	}

	const boundaryPrefix = `{"chunks":["`
	const boundaryMiddle = `","`
	const boundarySuffix = `"]}`
	firstChunk := strings.Repeat("a", 32768)
	secondChunk := strings.Repeat("b", maxApplicationActionArgumentsBytes-len(boundaryPrefix)-len(boundaryMiddle)-len(boundarySuffix)-len(firstChunk))
	intent.Arguments = json.RawMessage(boundaryPrefix + firstChunk + boundaryMiddle + secondChunk + boundarySuffix)
	if len(intent.Arguments) != maxApplicationActionArgumentsBytes {
		t.Fatalf("test fixture is %d bytes, want %d", len(intent.Arguments), maxApplicationActionArgumentsBytes)
	}
	if err := intent.Validate(); err != nil {
		t.Fatalf("64 KiB serialized arguments boundary rejected: %v", err)
	}
	intent.Arguments = json.RawMessage(boundaryPrefix + firstChunk + boundaryMiddle + secondChunk + "b" + boundarySuffix)
	if err := intent.Validate(); err == nil {
		t.Fatal("arguments beyond 64 KiB serialized JSON accepted")
	}

	intent.Arguments = json.RawMessage(strings.Repeat(`{"nested":`, maxApplicationActionJSONDepth+1) + `0` + strings.Repeat(`}`, maxApplicationActionJSONDepth+1))
	if err := intent.Validate(); err == nil {
		t.Fatal("arguments beyond the JSON nesting limit accepted")
	}
	intent.Arguments = json.RawMessage(`{"number":1e999}`)
	if err := intent.Validate(); err == nil {
		t.Fatal("non-finite JavaScript-number equivalent accepted")
	}
	value, err := decodeApplicationActionArguments(json.RawMessage(`{"number":1e3}`))
	if err != nil {
		t.Fatal(err)
	}
	if number := value.(map[string]any)["number"]; number != float64(1000) {
		t.Fatalf("scientific number did not use JavaScript Number semantics: %#v", number)
	}
	intent.Arguments = json.RawMessage(fmt.Sprintf(`{"value":%q}`, strings.Repeat("a", 32769)))
	if err := intent.Validate(); err == nil {
		t.Fatal("generic string beyond 32768 UTF-16 units accepted")
	}
	intent.Arguments = json.RawMessage(fmt.Sprintf(`{%q:true}`, strings.Repeat("k", 129)))
	if err := intent.Validate(); err == nil {
		t.Fatal("generic object key beyond 128 UTF-16 units accepted")
	}
	for _, key := range []string{"", "__proto__", "constructor", "prototype"} {
		intent.Arguments = json.RawMessage(fmt.Sprintf(`{%q:true}`, key))
		if err := intent.Validate(); err == nil {
			t.Fatalf("forbidden generic object key %q accepted", key)
		}
	}
	intent.Arguments = json.RawMessage(`{"\ud800":true}`)
	if err := intent.Validate(); err == nil {
		t.Fatal("unpaired surrogate in a generic argument key accepted")
	}

	foreign := Intent{ID: "open-1", Type: "open_app", AppID: "wechat", Arguments: json.RawMessage(`{}`)}
	if err := foreign.Validate(); err == nil {
		t.Fatal("application action arguments accepted on another intent type")
	}
}

func TestIntentWireDecoderPreservesForbiddenFieldPresence(t *testing.T) {
	for _, encoded := range []string{
		`{"message":"ok","mood":"neutral","intents":[{"id":"open-1","type":"open_app","appId":"wechat","actionId":""}]}`,
		`{"message":"ok","mood":"neutral","intents":[{"id":"send-1","type":"execute_app_action","appId":"wechat","actionId":"wechat.message.send_to_current","arguments":{"text":"hello"},"listingId":""}]}`,
		`{"message":"ok","mood":"neutral","intents":[{"id":"send-1","type":"execute_app_action","appId":"wechat","actionId":"wechat.message.send_to_current","arguments":{"text":"hello"},"preferences":null}]}`,
		`{"message":"ok","mood":"neutral","intents":[{"id":"open-1","type":"open_app","appId":"wechat","expectedRevision":null}]}`,
	} {
		var output AgentOutput
		if err := DecodeStrict([]byte(encoded), &output); err != nil {
			t.Fatal(err)
		}
		if err := output.Validate(); err == nil {
			t.Fatalf("wire-only forbidden field presence accepted: %s", encoded)
		}
	}
}

func TestChatContextValidatesAvailableApplicationActionDescriptors(t *testing.T) {
	descriptor := ApplicationActionDescriptor{
		AppID: "wechat", ActionID: wechatSendToCurrentActionID,
		ArgumentSchemaID: wechatSendToCurrentArgumentSchemaID,
	}
	request := ChatRequest{
		RequestID: "request-1", ThreadID: "thread-1", Message: "send hello",
		Context: ChatContext{OSRevision: ptr[int64](1), AvailableApplicationActions: []ApplicationActionDescriptor{descriptor}},
	}
	if err := request.Validate(); err != nil {
		t.Fatalf("valid application action descriptor rejected: %v", err)
	}

	request.Context.AvailableApplicationActions = []ApplicationActionDescriptor{descriptor, descriptor}
	if err := request.Validate(); err == nil {
		t.Fatal("duplicate application action descriptor accepted")
	}
	request.Context.AvailableApplicationActions = []ApplicationActionDescriptor{{
		AppID: "settings", ActionID: wechatSendToCurrentActionID, ArgumentSchemaID: wechatSendToCurrentArgumentSchemaID,
	}}
	if err := request.Validate(); err == nil {
		t.Fatal("WeChat action descriptor bound to another app accepted")
	}
	request.Context.AvailableApplicationActions = []ApplicationActionDescriptor{{
		AppID: "calendar", ActionID: "calendar.event.create", ArgumentSchemaID: "calendar.event.create.arguments@2",
	}}
	if err := request.Validate(); err == nil {
		t.Fatal("unregistered future action descriptor accepted")
	}
	request.Context.AvailableApplicationActions = make([]ApplicationActionDescriptor, 65)
	for index := range request.Context.AvailableApplicationActions {
		request.Context.AvailableApplicationActions[index] = ApplicationActionDescriptor{
			AppID: "calendar", ActionID: fmt.Sprintf("calendar.event.action_%d", index+1),
			ArgumentSchemaID: fmt.Sprintf("calendar.event.action_%d.arguments@1", index+1),
		}
	}
	if err := request.Validate(); err == nil {
		t.Fatal("available application action collection beyond 64 accepted")
	}
}

func TestGameDecisionRequestMatchesBrowserActiveDecisionContract(t *testing.T) {
	request := GameDecisionRequest{
		RequestID: "game-request-1", GameID: "cards.game", GameVersion: "1.0.0", MatchID: "match-1", SeatID: "seat-a",
		Observation: GameObservation{
			Revision: 4, Terminal: false,
			Decision:    DecisionWindow{Mode: "sequential", Phase: "play", ActiveSeatIDs: []string{"seat-a"}, TurnNonce: "turn-4"},
			Observation: json.RawMessage(`{"handCount":5}`),
		},
		LegalActions: []LegalAction{
			{ID: "action-1", Label: "Play", Action: json.RawMessage(`{"type":"play"}`)},
			{ID: "action-2", Label: "Pass", Action: json.RawMessage(`{"type":"pass"}`)},
		},
	}
	if err := request.Validate(); err != nil {
		t.Fatal(err)
	}
	request.Observation.Terminal = true
	if err := request.Validate(); err == nil {
		t.Fatal("terminal observation accepted")
	}
	request.Observation.Terminal = false
	request.Observation.Decision.ActiveSeatIDs = []string{"seat-b"}
	if err := request.Validate(); err == nil {
		t.Fatal("inactive request seat accepted")
	}
	request.Observation.Decision.ActiveSeatIDs = []string{"seat-a"}
	request.LegalActions[1].ID = "action-1"
	if err := request.Validate(); err == nil {
		t.Fatal("duplicate legal action id accepted")
	}
}

func TestSurfaceRejectsReservedIDsAndCycles(t *testing.T) {
	reserved := Surface{Version: "1.0", ID: "__aios_fake", Components: []SurfaceComponent{{ID: "text", Type: "text", Text: "hello"}}}
	if err := reserved.Validate(map[string]struct{}{}); err == nil {
		t.Fatal("reserved surface id accepted")
	}
	root := Surface{Version: "1.0", ID: "root", Components: []SurfaceComponent{{ID: "text", Type: "text", Text: "hello"}}}
	if err := root.Validate(map[string]struct{}{}); err == nil {
		t.Fatal("renderer root id accepted")
	}
	cycle := Surface{Version: "1.0", ID: "surface", Components: []SurfaceComponent{{ID: "a", Type: "stack", Children: []string{"b"}}, {ID: "b", Type: "group", Children: []string{"a"}}}}
	if err := cycle.Validate(map[string]struct{}{}); err == nil {
		t.Fatal("surface cycle accepted")
	}
	duplicateChildren := Surface{Version: "1.0", ID: "duplicates", Components: []SurfaceComponent{{ID: "leaf", Type: "text", Text: "hello"}, {ID: "layout", Type: "stack", Children: []string{"leaf", "leaf"}}}}
	if err := duplicateChildren.Validate(map[string]struct{}{}); err == nil {
		t.Fatal("duplicate child reference accepted")
	}
	layers := make([][]string, 5)
	components := []SurfaceComponent{{ID: "dag-root", Type: "stack"}}
	for layer := range layers {
		for index := 0; index < 4; index++ {
			layers[layer] = append(layers[layer], fmt.Sprintf("layer-%d-%d", layer, index))
		}
	}
	components[0].Children = append([]string(nil), layers[0]...)
	for layer, ids := range layers {
		for _, id := range ids {
			children := layers[min(layer+1, len(layers)-1)]
			if layer == len(layers)-1 {
				leafID := "leaf-" + id
				children = []string{leafID}
				components = append(components, SurfaceComponent{ID: leafID, Type: "text", Text: "bounded"})
			}
			components = append(components, SurfaceComponent{ID: id, Type: "stack", Children: append([]string(nil), children...)})
		}
	}
	if err := (Surface{Version: "1.0", ID: "dag-bomb", Components: components}).Validate(map[string]struct{}{}); err == nil {
		t.Fatal("compact DAG exceeding expanded render budget accepted")
	}
	validDescription := strings.Repeat("a", 400)
	list := SurfaceComponent{ID: "list", Type: "list", Items: []ListItem{{ID: "item", Label: "Item", Description: validDescription}}}
	if err := list.Validate(map[string]struct{}{}); err != nil {
		t.Fatalf("400-byte list description rejected: %v", err)
	}
	list.Items[0].Description += "a"
	if err := list.Validate(map[string]struct{}{}); err == nil {
		t.Fatal("401-character list description accepted")
	}
	list.Items[0].Description = strings.Repeat("界", 400)
	if err := list.Validate(map[string]struct{}{}); err != nil {
		t.Fatalf("400 browser characters were not counted as UTF-16 units: %v", err)
	}
	list.Items[0].Description = strings.Repeat("\U0001F600", 201)
	if err := list.Validate(map[string]struct{}{}); err == nil {
		t.Fatal("402 UTF-16-unit list description accepted")
	}
	list.Items = []ListItem{{ID: "duplicate", Label: "First"}, {ID: "duplicate", Label: "Second"}}
	if err := list.Validate(map[string]struct{}{}); err == nil {
		t.Fatal("duplicate list item id accepted")
	}
}

func TestGeneratedManifestDigestMatchesCanonicalSortedJSON(t *testing.T) {
	manifest := AgentManifest{ID: "travel.planner", Name: "Travel Planner", Version: "1.0.0", Description: "Plans trips", Instructions: "Help with travel <safely> & clearly.", Capabilities: []string{"os.app.open", "a2ui.surface.publish"}}
	if err := manifest.FinalizeGenerated("run-1", "gpt-test"); err != nil {
		t.Fatal(err)
	}
	if err := manifest.Validate(); err != nil {
		t.Fatal(err)
	}
	if manifest.Publisher.Trust != "local-unverified" || manifest.GeneratedBy == nil || manifest.GeneratedBy.Provider != "codex" {
		t.Fatalf("invalid provenance: %+v", manifest)
	}
	canonical := `{"capabilities":["os.app.open","a2ui.surface.publish"],"contributions":["domain-agent"],"description":"Plans trips","generatedBy":{"model":"gpt-test","provider":"codex","runId":"run-1"},"id":"travel.planner","instructions":"Help with travel <safely> & clearly.","name":"Travel Planner","publisher":{"displayName":"Local Codex","id":"local.codex","trust":"local-unverified"},"version":"1.0.0"}`
	want := fmt.Sprintf("sha256:%x", sha256.Sum256([]byte(canonical)))
	if manifest.ContentDigest != want {
		t.Fatalf("digest mismatch\ngot  %s\nwant %s", manifest.ContentDigest, want)
	}
	copyManifest := manifest
	copyManifest.Description = "tampered"
	if err := copyManifest.Validate(); err == nil {
		t.Fatal("tampered manifest digest accepted")
	}
}

func TestManifestSemverAndCapabilityBoundsMatchBrowserContract(t *testing.T) {
	for _, version := range []string{"1.0.0", "1.0.0-rc.1", "1.0.0+build.7", "1.0.0-rc.1+build.7"} {
		manifest := AgentManifest{ID: "domain.helper", Name: "Helper", Version: version, Description: "Domain help", Instructions: "Help safely.", Capabilities: nil}
		if err := manifest.FinalizeGenerated("run-1", "test-model"); err != nil {
			t.Fatal(err)
		}
		if err := manifest.Validate(); err != nil {
			t.Fatalf("valid manifest version %q rejected: %v", version, err)
		}
	}
	for _, version := range []string{"1.0.0-01", "01.0.0", "1.0.0+", "1.0.0+" + strings.Repeat("a", 65)} {
		manifest := AgentManifest{ID: "domain.helper", Name: "Helper", Version: version, Description: "Domain help", Instructions: "Help safely."}
		if err := manifest.FinalizeGenerated("run-1", "test-model"); err != nil {
			t.Fatal(err)
		}
		if err := manifest.Validate(); err == nil {
			t.Fatalf("invalid manifest version %q accepted", version)
		}
	}
}

func TestGameRequestEnforcesSeatAndLegalAction(t *testing.T) {
	req := GameDecisionRequest{RequestID: "r-1", GameID: "doudizhu", GameVersion: "1.0.0", MatchID: "m-1", SeatID: "seat-1", Observation: GameObservation{Revision: 1, Decision: DecisionWindow{Mode: "sequential", Phase: "play", ActiveSeatIDs: []string{"seat-1"}, TurnNonce: "turn-1"}, Observation: json.RawMessage(`{"handCount":17}`)}, LegalActions: []LegalAction{{ID: "pass", Label: "Pass", Action: json.RawMessage(`{"type":"pass"}`)}}}
	if err := req.Validate(); err != nil {
		t.Fatal(err)
	}
	if !req.HasActionID("pass") || req.HasActionID("invented") {
		t.Fatal("legal action membership is wrong")
	}
	req.SeatID = "seat-2"
	if err := req.Validate(); err == nil {
		t.Fatal("inactive seat accepted")
	}
}

func TestAgentDebugProtocolUsesStrictProfileAndUTF16Bounds(t *testing.T) {
	request := AgentDebugTraceRequest{
		Profile: AgentDebugProfile,
		Request: ChatRequest{
			RequestID: "request-1", ThreadID: "thread-1", Message: "hello",
			Context: ChatContext{OSRevision: ptr[int64](1)},
		},
	}
	if err := request.Validate(); err != nil {
		t.Fatal(err)
	}
	request.Profile = "agent-debug.v2"
	if err := request.Validate(); err == nil {
		t.Fatal("unknown debug profile was accepted")
	}

	payload := AgentDebugTracePayload{
		Kind: "trace", TraceID: "trace-1", TimeUnixMS: 1, Source: "sidecar",
		Stage: "analysis", Status: "info", Title: strings.Repeat("😀", 40),
		Detail: strings.Repeat("😀", 120), ElapsedMS: 600000,
	}
	if err := payload.Validate(); err != nil {
		t.Fatalf("boundary trace rejected: %v", err)
	}
	payload.Title += "a"
	if err := payload.Validate(); err == nil {
		t.Fatal("title beyond 80 UTF-16 units was accepted")
	}
	payload.Title = "safe"
	payload.Detail += "a"
	if err := payload.Validate(); err == nil {
		t.Fatal("detail beyond 240 UTF-16 units was accepted")
	}
	payload.Detail = "safe"
	payload.ElapsedMS++
	if err := payload.Validate(); err == nil {
		t.Fatal("elapsed time beyond 600000ms was accepted")
	}
}
