package protocol

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"regexp"
	"sort"
	"strings"
)

const Version = "1.0.0"

var (
	idPattern       = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
	manifestPattern = regexp.MustCompile(`^[a-z0-9]+(?:[.-][a-z0-9]+)*$`)
	versionPattern  = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(\+([0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*))?$`)
	digestPattern   = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
)

type Usage struct {
	InputTokens        int   `json:"inputTokens"`
	OutputTokens       int   `json:"outputTokens"`
	CachedInputTokens  int   `json:"cachedInputTokens"`
	EstimatedCostMilli int64 `json:"estimatedCostMilli"`
}

type ErrorEnvelope struct {
	Error ErrorBody `json:"error"`
}

type ErrorBody struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	RequestID string `json:"requestId"`
	Retryable bool   `json:"retryable"`
}

type HealthResponse struct {
	ProtocolVersion string        `json:"protocolVersion"`
	Status          string        `json:"status"`
	Agent           HealthAgent   `json:"agent"`
	Limits          HealthLimits  `json:"limits"`
	Checks          []HealthCheck `json:"checks"`
}

type HealthAgent struct {
	Driver          string `json:"driver"`
	AuthMode        string `json:"authMode"`
	ProfileIsolated bool   `json:"profileIsolated"`
}

type HealthLimits struct {
	MaxBodyBytes      int64 `json:"maxBodyBytes"`
	MaxConcurrentRuns int   `json:"maxConcurrentRuns"`
}

type HealthCheck struct {
	Code    string `json:"code"`
	Status  string `json:"status"`
	Message string `json:"message"`
}

type ChatRequest struct {
	RequestID string             `json:"requestId"`
	ThreadID  string             `json:"threadId"`
	Message   string             `json:"message"`
	History   []ChatHistoryEntry `json:"history,omitempty"`
	Context   ChatContext        `json:"context"`
}

type ChatHistoryEntry struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type ChatContext struct {
	OSRevision        *int64         `json:"osRevision"`
	Locale            string         `json:"locale,omitempty"`
	ActiveAppID       string         `json:"activeAppId,omitempty"`
	Theme             string         `json:"theme,omitempty"`
	InstalledAppIDs   []string       `json:"installedAppIds,omitempty"`
	InstalledAgentIDs []string       `json:"installedAgentIds,omitempty"`
	RunningGames      []RunningGame  `json:"runningGames,omitempty"`
	SystemStatus      *SystemStatus  `json:"systemStatus,omitempty"`
	RunningGameIDs    []string       `json:"runningGameIds,omitempty"`
	EnabledAgents     []EnabledAgent `json:"enabledAgents,omitempty"`
}

type RunningGame struct {
	GameID            string   `json:"gameId"`
	MatchID           string   `json:"matchId"`
	ControlledSeatIDs []string `json:"controlledSeatIds"`
}

// EnabledAgent is the least-authority projection of an installed domain Agent
// that is useful to a model turn. Package provenance, digests, and grants stay
// in the trusted browser registry and are deliberately not prompt input.
type EnabledAgent struct {
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	Description   string   `json:"description"`
	Instructions  string   `json:"instructions"`
	Capabilities  []string `json:"capabilities"`
	Contributions []string `json:"contributions"`
}

type ChatResponse struct {
	RequestID     string   `json:"requestId"`
	RunID         string   `json:"runId"`
	Message       string   `json:"message"`
	Mood          string   `json:"mood"`
	ActiveAgentID string   `json:"activeAgentId,omitempty"`
	Intents       []Intent `json:"intents"`
	Surface       *Surface `json:"surface,omitempty"`
	Usage         *Usage   `json:"usage,omitempty"`
}

type AgentOutput struct {
	Message       string   `json:"message"`
	Mood          string   `json:"mood"`
	ActiveAgentID string   `json:"activeAgentId,omitempty"`
	Intents       []Intent `json:"intents"`
	Surface       *Surface `json:"surface,omitempty"`
}

type Intent struct {
	ID               string             `json:"id"`
	Type             string             `json:"type"`
	ExpectedRevision *int64             `json:"expectedRevision,omitempty"`
	AppID            string             `json:"appId,omitempty"`
	ListingID        string             `json:"listingId,omitempty"`
	Preferences      *Preferences       `json:"preferences,omitempty"`
	StatusPatch      *SystemStatusPatch `json:"statusPatch,omitempty"`
	Manifest         *AgentManifest     `json:"manifest,omitempty"`
}

type Preferences struct {
	Theme             *string `json:"theme,omitempty"`
	ReduceMotion      *bool   `json:"reduceMotion,omitempty"`
	SoundEffects      *bool   `json:"soundEffects,omitempty"`
	DockMagnification *bool   `json:"dockMagnification,omitempty"`
	Accent            *string `json:"accent,omitempty"`
}

// SystemStatus is the bounded browser-owned status snapshot visible to the
// assistant. It contains no device identifiers, network addresses, or secrets.
type SystemStatus struct {
	WifiEnabled      *bool    `json:"wifiEnabled"`
	WifiLabel        string   `json:"wifiLabel"`
	BluetoothEnabled *bool    `json:"bluetoothEnabled"`
	BluetoothLabel   string   `json:"bluetoothLabel"`
	HealthScore      *int     `json:"healthScore"`
	StorageUsedGB    *float64 `json:"storageUsedGb"`
	StorageTotalGB   *float64 `json:"storageTotalGb"`
	EnergyMode       string   `json:"energyMode"`
	Brightness       *int     `json:"brightness"`
	Volume           *int     `json:"volume"`
}

// SystemStatusPatch preserves omitted-vs-zero semantics for the closed
// set_system_status intent. The trusted browser host validates the merged
// status again immediately before committing it.
type SystemStatusPatch struct {
	WifiEnabled      *bool   `json:"wifiEnabled,omitempty"`
	BluetoothEnabled *bool   `json:"bluetoothEnabled,omitempty"`
	EnergyMode       *string `json:"energyMode,omitempty"`
	Brightness       *int    `json:"brightness,omitempty"`
	Volume           *int    `json:"volume,omitempty"`
}

type AgentManifest struct {
	ID            string            `json:"id"`
	Name          string            `json:"name"`
	Version       string            `json:"version"`
	Description   string            `json:"description"`
	Instructions  string            `json:"instructions"`
	Capabilities  []string          `json:"capabilities"`
	Publisher     AgentPublisher    `json:"publisher"`
	GeneratedBy   *AgentGeneratedBy `json:"generatedBy,omitempty"`
	Contributions []string          `json:"contributions"`
	ContentDigest string            `json:"contentDigest"`
}

type AgentPublisher struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName"`
	Trust       string `json:"trust"`
}
type AgentGeneratedBy struct {
	Provider string `json:"provider"`
	Model    string `json:"model,omitempty"`
	RunID    string `json:"runId"`
}

type Surface struct {
	Version    string             `json:"version"`
	ID         string             `json:"id"`
	Title      string             `json:"title,omitempty"`
	Components []SurfaceComponent `json:"components"`
}

type SurfaceComponent struct {
	ID       string     `json:"id"`
	Type     string     `json:"type"`
	Text     string     `json:"text,omitempty"`
	Tone     string     `json:"tone,omitempty"`
	Level    int        `json:"level,omitempty"`
	Label    string     `json:"label,omitempty"`
	IntentID string     `json:"intentId,omitempty"`
	Variant  string     `json:"variant,omitempty"`
	Children []string   `json:"children,omitempty"`
	Value    string     `json:"value,omitempty"`
	Items    []ListItem `json:"items,omitempty"`
}

type ListItem struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
}

type GameDecisionRequest struct {
	RequestID    string          `json:"requestId"`
	GameID       string          `json:"gameId"`
	GameVersion  string          `json:"gameVersion"`
	MatchID      string          `json:"matchId"`
	SeatID       string          `json:"seatId"`
	Observation  GameObservation `json:"observation"`
	LegalActions []LegalAction   `json:"legalActions"`
}

type GameObservation struct {
	Revision    int64           `json:"revision"`
	Terminal    bool            `json:"terminal"`
	Decision    DecisionWindow  `json:"decision"`
	Observation json.RawMessage `json:"observation"`
}

type DecisionWindow struct {
	Mode          string   `json:"mode"`
	Phase         string   `json:"phase"`
	ActiveSeatIDs []string `json:"activeSeatIds"`
	TurnNonce     string   `json:"turnNonce"`
}

type LegalAction struct {
	ID     string          `json:"id"`
	Label  string          `json:"label"`
	Action json.RawMessage `json:"action"`
}

type GameAgentOutput struct {
	ActionID string `json:"actionId"`
}

type GameDecisionResponse struct {
	RequestID string `json:"requestId"`
	RunID     string `json:"runId"`
	ActionID  string `json:"actionId"`
	Usage     *Usage `json:"usage,omitempty"`
}

func DecodeStrict(data []byte, dst any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dst); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err == nil {
		return errors.New("multiple JSON values are not allowed")
	} else if !errors.Is(err, io.EOF) {
		return err
	}
	return nil
}

func (r ChatRequest) Validate() error {
	if err := validateID("requestId", r.RequestID); err != nil {
		return err
	}
	if err := validateID("threadId", r.ThreadID); err != nil {
		return err
	}
	if err := bounded("message", r.Message, 1, 12000); err != nil {
		return err
	}
	if len(r.History) > 12 {
		return errors.New("history exceeds limit")
	}
	historyUnits := 0
	for _, entry := range r.History {
		if entry.Role != "user" && entry.Role != "assistant" {
			return errors.New("history role is invalid")
		}
		if err := bounded("history content", entry.Content, 1, 2000); err != nil {
			return err
		}
		historyUnits += utf16CodeUnits(entry.Content)
		if historyUnits > 12000 {
			return errors.New("history content exceeds aggregate limit")
		}
	}
	if r.Context.OSRevision == nil || *r.Context.OSRevision < 0 || *r.Context.OSRevision > 9007199254740991 {
		return errors.New("context.osRevision is required and cannot be negative")
	}
	if r.Context.Locale != "" && (utf16CodeUnits(r.Context.Locale) < 2 || utf16CodeUnits(r.Context.Locale) > 32) {
		return errors.New("locale length is invalid")
	}
	if r.Context.ActiveAppID != "" {
		if err := bounded("activeAppId", r.Context.ActiveAppID, 1, 128); err != nil {
			return err
		}
	}
	if r.Context.Theme != "" {
		if err := bounded("theme", r.Context.Theme, 1, 64); err != nil {
			return err
		}
	}
	if len(r.Context.InstalledAppIDs) > 256 || len(r.Context.InstalledAgentIDs) > 128 || len(r.Context.RunningGames) > 32 {
		return errors.New("context collection exceeds limit")
	}
	for _, id := range append(append([]string{}, r.Context.InstalledAppIDs...), r.Context.InstalledAgentIDs...) {
		if err := bounded("installed id", id, 1, 128); err != nil {
			return err
		}
	}
	for _, game := range r.Context.RunningGames {
		if err := bounded("gameId", game.GameID, 1, 128); err != nil {
			return err
		}
		if err := bounded("matchId", game.MatchID, 1, 128); err != nil {
			return err
		}
		if len(game.ControlledSeatIDs) > 32 {
			return errors.New("controlledSeatIds exceeds limit")
		}
		for _, seat := range game.ControlledSeatIDs {
			if err := bounded("seatId", seat, 1, 128); err != nil {
				return err
			}
		}
	}
	if r.Context.SystemStatus != nil {
		if err := r.Context.SystemStatus.Validate(); err != nil {
			return fmt.Errorf("context.systemStatus: %w", err)
		}
	}
	if len(r.Context.RunningGameIDs) > 32 {
		return errors.New("runningGameIds exceeds limit")
	}
	runningIDs := make(map[string]struct{}, len(r.Context.RunningGameIDs))
	for _, id := range r.Context.RunningGameIDs {
		if err := bounded("runningGameId", id, 1, 128); err != nil {
			return err
		}
		if _, exists := runningIDs[id]; exists {
			return fmt.Errorf("duplicate runningGameId %q", id)
		}
		runningIDs[id] = struct{}{}
	}
	if len(r.Context.EnabledAgents) > 16 {
		return errors.New("enabledAgents exceeds limit")
	}
	agentIDs := make(map[string]struct{}, len(r.Context.EnabledAgents))
	totalInstructions := 0
	for _, enabledAgent := range r.Context.EnabledAgents {
		if err := enabledAgent.Validate(); err != nil {
			return fmt.Errorf("enabled agent %q: %w", enabledAgent.ID, err)
		}
		if _, exists := agentIDs[enabledAgent.ID]; exists {
			return fmt.Errorf("duplicate enabled agent id %q", enabledAgent.ID)
		}
		agentIDs[enabledAgent.ID] = struct{}{}
		totalInstructions += utf16CodeUnits(enabledAgent.Instructions)
		if totalInstructions > 48000 {
			return errors.New("enabled agent instructions exceed aggregate limit")
		}
	}
	return nil
}

func (a EnabledAgent) Validate() error {
	if err := bounded("enabled agent id", a.ID, 3, 128); err != nil {
		return err
	}
	if err := validateID("enabled agent id", a.ID); err != nil {
		return err
	}
	if err := bounded("enabled agent name", a.Name, 1, 80); err != nil {
		return err
	}
	if err := bounded("enabled agent description", a.Description, 1, 500); err != nil {
		return err
	}
	if err := bounded("enabled agent instructions", a.Instructions, 1, 12000); err != nil {
		return err
	}
	if len(a.Capabilities) > len(allowedCapabilities) {
		return errors.New("enabled agent capabilities count is invalid")
	}
	capabilities := make(map[string]struct{}, len(a.Capabilities))
	for _, capability := range a.Capabilities {
		if _, allowed := allowedCapabilities[capability]; !allowed {
			return fmt.Errorf("unsupported capability %q", capability)
		}
		if _, duplicate := capabilities[capability]; duplicate {
			return fmt.Errorf("duplicate capability %q", capability)
		}
		capabilities[capability] = struct{}{}
	}
	if len(a.Contributions) > 3 || !containsString(a.Contributions, "domain-agent") {
		return errors.New("enabled Agent must declare the domain-agent contribution")
	}
	contributions := make(map[string]struct{}, len(a.Contributions))
	for _, contribution := range a.Contributions {
		switch contribution {
		case "domain-agent", "game-controller", "a2ui-surface-provider":
		default:
			return fmt.Errorf("unsupported contribution %q", contribution)
		}
		if _, duplicate := contributions[contribution]; duplicate {
			return fmt.Errorf("duplicate contribution %q", contribution)
		}
		contributions[contribution] = struct{}{}
	}
	return nil
}

func (o AgentOutput) Validate() error {
	if err := bounded("message", o.Message, 1, 12000); err != nil {
		return err
	}
	switch o.Mood {
	case "neutral", "helpful", "focused", "celebratory", "concerned":
	default:
		return errors.New("unsupported mood")
	}
	if o.ActiveAgentID != "" {
		if err := validateID("activeAgentId", o.ActiveAgentID); err != nil {
			return err
		}
	}
	if len(o.Intents) > 1 {
		return errors.New("only one intent is allowed per turn")
	}
	intentIDs := make(map[string]struct{}, len(o.Intents))
	for _, intent := range o.Intents {
		if err := intent.Validate(); err != nil {
			return err
		}
		if _, exists := intentIDs[intent.ID]; exists {
			return fmt.Errorf("duplicate intent id %q", intent.ID)
		}
		intentIDs[intent.ID] = struct{}{}
	}
	if o.Surface != nil {
		return o.Surface.Validate(intentIDs)
	}
	return nil
}

func (i Intent) Validate() error {
	if err := validateID("intent id", i.ID); err != nil {
		return err
	}
	if i.ExpectedRevision != nil && (*i.ExpectedRevision < 0 || *i.ExpectedRevision > 9007199254740991) {
		return errors.New("expectedRevision cannot be negative")
	}
	switch i.Type {
	case "open_app", "close_app", "focus_app", "minimize_app":
		if err := bounded("appId", i.AppID, 1, 128); err != nil {
			return err
		}
		if i.ListingID != "" || i.Preferences != nil || i.StatusPatch != nil || i.Manifest != nil {
			return errors.New("intent contains fields outside its type")
		}
	case "install_app":
		if err := bounded("listingId", i.ListingID, 1, 128); err != nil {
			return err
		}
		if i.AppID != "" || i.Preferences != nil || i.StatusPatch != nil || i.Manifest != nil {
			return errors.New("intent contains fields outside its type")
		}
	case "set_preferences":
		if i.Preferences == nil || i.AppID != "" || i.ListingID != "" || i.StatusPatch != nil || i.Manifest != nil {
			return errors.New("invalid set_preferences intent")
		}
		if err := i.Preferences.Validate(); err != nil {
			return err
		}
	case "set_system_status":
		if i.StatusPatch == nil || i.AppID != "" || i.ListingID != "" || i.Preferences != nil || i.Manifest != nil {
			return errors.New("invalid set_system_status intent")
		}
		if err := i.StatusPatch.Validate(); err != nil {
			return err
		}
	case "install_agent":
		if i.Manifest == nil || i.AppID != "" || i.ListingID != "" || i.Preferences != nil || i.StatusPatch != nil {
			return errors.New("invalid install_agent intent")
		}
		if err := i.Manifest.Validate(); err != nil {
			return err
		}
	default:
		return fmt.Errorf("unsupported intent type %q", i.Type)
	}
	return nil
}

func (p Preferences) Validate() error {
	if p.Theme == nil && p.ReduceMotion == nil && p.SoundEffects == nil && p.DockMagnification == nil && p.Accent == nil {
		return errors.New("preferences cannot be empty")
	}
	if p.Theme != nil && *p.Theme != "aurora" && *p.Theme != "midnight" {
		return errors.New("unsupported preference theme")
	}
	if p.Accent != nil && *p.Accent != "lime" && *p.Accent != "cyan" && *p.Accent != "amber" {
		return errors.New("unsupported preference accent")
	}
	return nil
}

func (s SystemStatus) Validate() error {
	if s.WifiEnabled == nil || s.BluetoothEnabled == nil || s.HealthScore == nil || s.StorageUsedGB == nil || s.StorageTotalGB == nil || s.Brightness == nil || s.Volume == nil {
		return errors.New("all systemStatus fields are required")
	}
	if err := bounded("wifiLabel", s.WifiLabel, 1, 64); err != nil {
		return err
	}
	if err := bounded("bluetoothLabel", s.BluetoothLabel, 1, 64); err != nil {
		return err
	}
	if *s.HealthScore < 0 || *s.HealthScore > 100 {
		return errors.New("healthScore must be between 0 and 100")
	}
	if math.IsNaN(*s.StorageUsedGB) || math.IsInf(*s.StorageUsedGB, 0) || *s.StorageUsedGB < 0 {
		return errors.New("storageUsedGb must be finite and non-negative")
	}
	if math.IsNaN(*s.StorageTotalGB) || math.IsInf(*s.StorageTotalGB, 0) || *s.StorageTotalGB <= 0 || *s.StorageUsedGB > *s.StorageTotalGB {
		return errors.New("storageTotalGb must be finite, positive, and not less than storageUsedGb")
	}
	if !validEnergyMode(s.EnergyMode) {
		return errors.New("unsupported energyMode")
	}
	if *s.Brightness < 0 || *s.Brightness > 100 || *s.Volume < 0 || *s.Volume > 100 {
		return errors.New("brightness and volume must be between 0 and 100")
	}
	return nil
}

func (p SystemStatusPatch) Validate() error {
	if p.WifiEnabled == nil && p.BluetoothEnabled == nil && p.EnergyMode == nil && p.Brightness == nil && p.Volume == nil {
		return errors.New("statusPatch cannot be empty")
	}
	if p.EnergyMode != nil && !validEnergyMode(*p.EnergyMode) {
		return errors.New("unsupported energyMode")
	}
	if p.Brightness != nil && (*p.Brightness < 0 || *p.Brightness > 100) {
		return errors.New("brightness must be between 0 and 100")
	}
	if p.Volume != nil && (*p.Volume < 0 || *p.Volume > 100) {
		return errors.New("volume must be between 0 and 100")
	}
	return nil
}

func validEnergyMode(value string) bool {
	return value == "Eco" || value == "Balanced" || value == "Performance"
}

var allowedCapabilities = map[string]struct{}{
	"os.app.open": {}, "os.app.close": {}, "os.app.focus": {}, "os.app.minimize": {}, "os.preferences.write": {}, "os.system-status.write": {}, "store.app.install": {}, "agent.package.install": {}, "a2ui.surface.publish": {},
}

func (m AgentManifest) Validate() error {
	if len(m.ID) < 3 || len(m.ID) > 128 || !manifestPattern.MatchString(m.ID) {
		return errors.New("manifest id is invalid")
	}
	if err := bounded("manifest name", m.Name, 1, 80); err != nil {
		return err
	}
	if utf16CodeUnits(m.Version) > 64 || !versionPattern.MatchString(m.Version) {
		return errors.New("manifest version must be semantic")
	}
	if err := bounded("manifest description", m.Description, 1, 500); err != nil {
		return err
	}
	if err := bounded("manifest instructions", m.Instructions, 1, 12000); err != nil {
		return err
	}
	for _, text := range []string{m.Name, m.Description, m.Instructions} {
		if strings.ContainsAny(text, "\u2028\u2029") {
			return errors.New("manifest text contains an unsupported line separator")
		}
	}
	if len(m.Capabilities) > len(allowedCapabilities) {
		return errors.New("manifest capabilities count is invalid")
	}
	seen := map[string]struct{}{}
	for _, capability := range m.Capabilities {
		if _, ok := allowedCapabilities[capability]; !ok {
			return fmt.Errorf("unsupported capability %q", capability)
		}
		if _, ok := seen[capability]; ok {
			return fmt.Errorf("duplicate capability %q", capability)
		}
		seen[capability] = struct{}{}
	}
	if len(m.Publisher.ID) < 3 || len(m.Publisher.ID) > 128 || !manifestPattern.MatchString(m.Publisher.ID) || utf16CodeUnits(strings.TrimSpace(m.Publisher.DisplayName)) < 1 || utf16CodeUnits(m.Publisher.DisplayName) > 80 {
		return errors.New("manifest publisher is invalid")
	}
	if m.Publisher.Trust != "local-unverified" && m.Publisher.Trust != "first-party" {
		return errors.New("manifest publisher trust is invalid")
	}
	if m.GeneratedBy != nil {
		if m.GeneratedBy.Provider != "codex" || !idPattern.MatchString(m.GeneratedBy.RunID) || utf16CodeUnits(m.GeneratedBy.Model) > 128 {
			return errors.New("manifest generator is invalid")
		}
	}
	if len(m.Contributions) > 3 {
		return errors.New("manifest contributions count is invalid")
	}
	contributions := map[string]struct{}{}
	for _, contribution := range m.Contributions {
		switch contribution {
		case "domain-agent", "game-controller", "a2ui-surface-provider":
		default:
			return fmt.Errorf("unsupported contribution %q", contribution)
		}
		if _, exists := contributions[contribution]; exists {
			return fmt.Errorf("duplicate contribution %q", contribution)
		}
		contributions[contribution] = struct{}{}
	}
	if !digestPattern.MatchString(m.ContentDigest) {
		return errors.New("manifest contentDigest is invalid")
	}
	want, err := m.digest()
	if err != nil {
		return err
	}
	if m.ContentDigest != want {
		return errors.New("manifest contentDigest does not match canonical content")
	}
	return nil
}

func (m *AgentManifest) FinalizeGenerated(runID, model string) error {
	if m == nil {
		return errors.New("manifest is required")
	}
	m.Publisher = AgentPublisher{ID: "local.codex", DisplayName: "Local Codex", Trust: "local-unverified"}
	m.GeneratedBy = &AgentGeneratedBy{Provider: "codex", Model: model, RunID: runID}
	if len(m.Contributions) == 0 {
		m.Contributions = []string{"domain-agent"}
	}
	m.ContentDigest = ""
	digest, err := m.digest()
	if err != nil {
		return err
	}
	m.ContentDigest = digest
	return nil
}

func (m AgentManifest) digest() (string, error) {
	raw, err := json.Marshal(m)
	if err != nil {
		return "", err
	}
	var content map[string]any
	if err := json.Unmarshal(raw, &content); err != nil {
		return "", err
	}
	delete(content, "contentDigest")
	canonical, err := canonicalJSON(content)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(canonical)
	return fmt.Sprintf("sha256:%x", sum), nil
}

func canonicalJSON(value any) ([]byte, error) {
	switch typed := value.(type) {
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		var out bytes.Buffer
		out.WriteByte('{')
		for index, key := range keys {
			if index > 0 {
				out.WriteByte(',')
			}
			encodedKey, _ := marshalCanonicalScalar(key)
			out.Write(encodedKey)
			out.WriteByte(':')
			encodedValue, err := canonicalJSON(typed[key])
			if err != nil {
				return nil, err
			}
			out.Write(encodedValue)
		}
		out.WriteByte('}')
		return out.Bytes(), nil
	case []any:
		var out bytes.Buffer
		out.WriteByte('[')
		for index, entry := range typed {
			if index > 0 {
				out.WriteByte(',')
			}
			encoded, err := canonicalJSON(entry)
			if err != nil {
				return nil, err
			}
			out.Write(encoded)
		}
		out.WriteByte(']')
		return out.Bytes(), nil
	default:
		return marshalCanonicalScalar(typed)
	}
}

func marshalCanonicalScalar(value any) ([]byte, error) {
	var out bytes.Buffer
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(out.Bytes(), []byte{'\n'}), nil
}

func (s Surface) Validate(intentIDs map[string]struct{}) error {
	if s.Version != "1.0" {
		return errors.New("unsupported surface version")
	}
	if err := validateSurfaceID("surface id", s.ID); err != nil {
		return err
	}
	if (s.Title != "" && utf16CodeUnits(s.Title) > 160) || len(s.Components) == 0 || len(s.Components) > 64 {
		return errors.New("surface size is invalid")
	}
	componentIDs := map[string]struct{}{}
	renderNodeCount := 1
	if s.Title != "" {
		renderNodeCount++
	}
	for _, component := range s.Components {
		if err := component.Validate(intentIDs); err != nil {
			return err
		}
		if _, ok := componentIDs[component.ID]; ok {
			return fmt.Errorf("duplicate component id %q", component.ID)
		}
		componentIDs[component.ID] = struct{}{}
		switch component.Type {
		case "button":
			renderNodeCount += 2
		case "list":
			renderNodeCount += 1 + len(component.Items)
		default:
			renderNodeCount++
		}
		if renderNodeCount > 128 {
			return errors.New("expanded surface exceeds 128 render nodes")
		}
	}
	referenced := map[string]struct{}{}
	for _, component := range s.Components {
		seenChildren := make(map[string]struct{}, len(component.Children))
		for _, child := range component.Children {
			if _, duplicate := seenChildren[child]; duplicate {
				return fmt.Errorf("component %q contains duplicate child %q", component.ID, child)
			}
			seenChildren[child] = struct{}{}
			if _, ok := componentIDs[child]; !ok {
				return fmt.Errorf("component %q references missing child %q", component.ID, child)
			}
			referenced[child] = struct{}{}
		}
	}
	byID := make(map[string]SurfaceComponent, len(s.Components))
	for _, component := range s.Components {
		byID[component.ID] = component
	}
	expandedNodeCount := 1
	if s.Title != "" {
		expandedNodeCount++
	}
	var visit func(string, map[string]struct{}, int) error
	visit = func(id string, ancestry map[string]struct{}, depth int) error {
		expandedNodeCount++
		if expandedNodeCount > 128 {
			return errors.New("expanded surface exceeds 128 render nodes")
		}
		if depth > 8 {
			return fmt.Errorf("component %q exceeds maximum depth", id)
		}
		if _, exists := ancestry[id]; exists {
			return fmt.Errorf("component graph contains a cycle at %q", id)
		}
		component := byID[id]
		if component.Type != "stack" && component.Type != "group" {
			return nil
		}
		next := make(map[string]struct{}, len(ancestry)+1)
		for key := range ancestry {
			next[key] = struct{}{}
		}
		next[id] = struct{}{}
		for _, child := range component.Children {
			if err := visit(child, next, depth+1); err != nil {
				return err
			}
		}
		return nil
	}
	roots := 0
	for id := range componentIDs {
		if _, isChild := referenced[id]; !isChild {
			roots++
			if err := visit(id, map[string]struct{}{}, 1); err != nil {
				return err
			}
		}
	}
	if roots == 0 {
		return errors.New("surface has no root component")
	}
	return nil
}

func (c SurfaceComponent) Validate(intentIDs map[string]struct{}) error {
	if err := validateSurfaceID("component id", c.ID); err != nil {
		return err
	}
	switch c.Type {
	case "text":
		if err := bounded("component text", c.Text, 1, 2000); err != nil {
			return err
		}
		if c.Tone != "" && c.Tone != "neutral" && c.Tone != "positive" && c.Tone != "warning" && c.Tone != "critical" {
			return errors.New("unsupported text tone")
		}
		if c.Level != 0 || c.Label != "" || c.IntentID != "" || c.Variant != "" || len(c.Children) != 0 || c.Value != "" || len(c.Items) != 0 {
			return errors.New("text component contains fields outside its type")
		}
	case "heading":
		if err := bounded("heading text", c.Text, 1, 240); err != nil {
			return err
		}
		if c.Level < 1 || c.Level > 3 {
			return errors.New("heading level is invalid")
		}
		if c.Tone != "" || c.Label != "" || c.IntentID != "" || c.Variant != "" || len(c.Children) != 0 || c.Value != "" || len(c.Items) != 0 {
			return errors.New("heading component contains fields outside its type")
		}
	case "button":
		if err := bounded("button label", c.Label, 1, 120); err != nil {
			return err
		}
		if _, ok := intentIDs[c.IntentID]; !ok {
			return errors.New("button must reference an existing intent")
		}
		if c.Variant != "" && c.Variant != "default" && c.Variant != "primary" && c.Variant != "borderless" {
			return errors.New("unsupported button variant")
		}
		if c.Text != "" || c.Tone != "" || c.Level != 0 || len(c.Children) != 0 || c.Value != "" || len(c.Items) != 0 {
			return errors.New("button component contains fields outside its type")
		}
	case "stack", "group":
		if len(c.Children) > 32 {
			return errors.New("container children count is invalid")
		}
		if c.Text != "" || c.Tone != "" || c.Level != 0 || c.Label != "" || c.IntentID != "" || c.Variant != "" || c.Value != "" || len(c.Items) != 0 {
			return errors.New("container component contains fields outside its type")
		}
	case "status":
		if err := bounded("status label", c.Label, 1, 120); err != nil {
			return err
		}
		if err := bounded("status value", c.Value, 1, 240); err != nil {
			return err
		}
		if c.Tone != "" && c.Tone != "neutral" && c.Tone != "positive" && c.Tone != "warning" && c.Tone != "critical" {
			return errors.New("unsupported status tone")
		}
		if c.Text != "" || c.Level != 0 || c.IntentID != "" || c.Variant != "" || len(c.Children) != 0 || len(c.Items) != 0 {
			return errors.New("status component contains fields outside its type")
		}
	case "list":
		if len(c.Items) == 0 || len(c.Items) > 32 {
			return errors.New("list size is invalid")
		}
		seenItemIDs := make(map[string]struct{}, len(c.Items))
		for _, item := range c.Items {
			if err := validateSurfaceID("list item id", item.ID); err != nil {
				return err
			}
			if _, duplicate := seenItemIDs[item.ID]; duplicate {
				return fmt.Errorf("duplicate list item id %q", item.ID)
			}
			seenItemIDs[item.ID] = struct{}{}
			if err := bounded("list item label", item.Label, 1, 160); err != nil {
				return err
			}
			if utf16CodeUnits(item.Description) > 400 {
				return errors.New("list item description is too long")
			}
		}
		if c.Text != "" || c.Tone != "" || c.Level != 0 || c.Label != "" || c.IntentID != "" || c.Variant != "" || len(c.Children) != 0 || c.Value != "" {
			return errors.New("list component contains fields outside its type")
		}
	default:
		return fmt.Errorf("unsupported component type %q", c.Type)
	}
	return nil
}

func (r GameDecisionRequest) Validate() error {
	if err := validateID("requestId", r.RequestID); err != nil {
		return err
	}
	for name, item := range map[string]struct {
		value string
		max   int
	}{"gameId": {r.GameID, 128}, "gameVersion": {r.GameVersion, 64}, "matchId": {r.MatchID, 128}, "seatId": {r.SeatID, 128}} {
		if err := bounded(name, item.value, 1, item.max); err != nil {
			return err
		}
	}
	if r.Observation.Revision < 0 || r.Observation.Revision > 9007199254740991 || r.Observation.Terminal {
		return errors.New("observation is not an active decision")
	}
	if r.Observation.Decision.Mode != "sequential" && r.Observation.Decision.Mode != "simultaneous" {
		return errors.New("unsupported decision mode")
	}
	if err := bounded("phase", r.Observation.Decision.Phase, 1, 128); err != nil {
		return err
	}
	if err := bounded("turnNonce", r.Observation.Decision.TurnNonce, 1, 256); err != nil {
		return err
	}
	if len(r.Observation.Decision.ActiveSeatIDs) == 0 || len(r.Observation.Decision.ActiveSeatIDs) > 32 {
		return errors.New("activeSeatIds count is invalid")
	}
	active := false
	for _, id := range r.Observation.Decision.ActiveSeatIDs {
		if err := bounded("activeSeatId", id, 1, 128); err != nil {
			return err
		}
		active = active || id == r.SeatID
	}
	if !active {
		return errors.New("seat is not active")
	}
	if !validJSONValue(r.Observation.Observation) {
		return errors.New("observation must be a JSON value")
	}
	if len(r.LegalActions) == 0 || len(r.LegalActions) > 20000 {
		return errors.New("legalActions count is invalid")
	}
	seen := map[string]struct{}{}
	for _, action := range r.LegalActions {
		if err := bounded("action id", action.ID, 1, 128); err != nil {
			return err
		}
		if _, ok := seen[action.ID]; ok {
			return fmt.Errorf("duplicate action id %q", action.ID)
		}
		seen[action.ID] = struct{}{}
		if err := bounded("action label", action.Label, 1, 240); err != nil {
			return err
		}
		if !validJSONValue(action.Action) {
			return errors.New("legal action must be a JSON value")
		}
	}
	return nil
}

func (r GameDecisionRequest) HasActionID(id string) bool {
	for _, action := range r.LegalActions {
		if action.ID == id {
			return true
		}
	}
	return false
}

func validJSONValue(value json.RawMessage) bool {
	var decoded any
	return len(value) > 0 && json.Unmarshal(value, &decoded) == nil
}
func validateID(name, value string) error {
	if !idPattern.MatchString(value) {
		return fmt.Errorf("%s is invalid", name)
	}
	return nil
}

func validateSurfaceID(name, value string) error {
	if err := validateID(name, value); err != nil {
		return err
	}
	if strings.HasPrefix(value, "__aios_") || value == "root" {
		return fmt.Errorf("%s uses a reserved identifier", name)
	}
	return nil
}
func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
func bounded(name, value string, min, max int) error {
	n := utf16CodeUnits(strings.TrimSpace(value))
	if n < min || utf16CodeUnits(value) > max {
		return fmt.Errorf("%s length is invalid", name)
	}
	return nil
}

// utf16CodeUnits matches JavaScript String.length, which is the unit used by
// the browser-side contract validators.
func utf16CodeUnits(value string) int {
	count := 0
	for _, codePoint := range value {
		if codePoint > 0xffff {
			count += 2
		} else {
			count++
		}
	}
	return count
}
