import { ArrowDownToLine, Command, ShieldCheck, TerminalSquare } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useSystemStore } from '../../system/useSystemStore';
import type { SystemPreferences, Theme } from '../../system/types';

type OutputKind = 'output' | 'error' | 'meta';

interface TerminalLine {
  id: number;
  prompt?: string;
  input?: string;
  kind?: OutputKind;
  text?: string;
}

const ACCENT_COLORS: Record<SystemPreferences['accent'], string> = {
  lime: '#C6F94D',
  cyan: '#64F5FF',
  amber: '#FFC46B',
};

const TERMINAL_THEME_BG: Record<Theme, string> = {
  aurora: 'linear-gradient(180deg, rgba(246, 250, 255, 0.98), rgba(223, 233, 250, 0.94))',
  midnight: 'linear-gradient(180deg, rgba(8, 12, 24, 0.98), rgba(3, 5, 12, 1))',
};

const TERMINAL_PANEL: Record<Theme, string> = {
  aurora: 'rgba(255,255,255,0.68)',
  midnight: 'rgba(5, 10, 21, 0.9)',
};

const TERMINAL_TEXT: Record<Theme, string> = {
  aurora: '#172033',
  midnight: '#E8F0FF',
};

const TERMINAL_MUTED: Record<Theme, string> = {
  aurora: '#5B6680',
  midnight: '#8F9CB8',
};

const PROMPT_PATH = '/Users/guest';
const USERNAME = 'guest';
const HOSTNAME = 'alsniper-os';

const FILES = ['Applications', 'Desktop', 'Documents', 'Downloads', 'Missions', 'Workspace'];

function line(text: string, kind: OutputKind = 'output'): TerminalLine {
  return { id: Math.random(), kind, text };
}

function bootMessage(theme: Theme): TerminalLine[] {
  return [
    line('AlSniper OS Terminal', 'meta'),
    line(`Session ready in ${theme} mode. Type "help" to list available commands.`, 'meta'),
  ];
}

export function TerminalApp() {
  const preferences = useSystemStore((state) => state.preferences);
  const updatePreferences = useSystemStore((state) => state.updatePreferences);
  const [lines, setLines] = useState<TerminalLine[]>(() => bootMessage(useSystemStore.getState().preferences.theme));
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [historyDraft, setHistoryDraft] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [lines]);

  const accent = ACCENT_COLORS[preferences.accent];
  const prompt = `${USERNAME}@${HOSTNAME}`;

  const append = (next: TerminalLine[]) => {
    setLines((current) => [...current, ...next]);
  };

  const runCommand = (raw: string) => {
    const trimmed = raw.trim();
    const nextLines: TerminalLine[] = [{ id: Date.now(), prompt, input: raw }];

    if (!trimmed) {
      append(nextLines);
      return;
    }

    const [command = '', ...args] = trimmed.split(/\s+/);
    const normalized = command.toLowerCase();

    if (normalized === 'clear') {
      setLines([]);
      return;
    }

    switch (normalized) {
      case 'help':
        nextLines.push(
          line('Available commands:', 'meta'),
          line('help      Show the supported command list'),
          line('about     Describe this browser-safe terminal session'),
          line('date      Print the current local date and time'),
          line('whoami    Print the current user'),
          line('pwd       Print the current working directory'),
          line('ls        List the top-level workspace folders'),
          line('clear     Clear the terminal output'),
          line('theme     Show or set the shell theme: theme [aurora|midnight]'),
        );
        break;
      case 'about':
        nextLines.push(
          line('This terminal is a safe browser simulation.', 'meta'),
          line('It never shells out, evaluates scripts, or accesses host files directly.'),
          line('Commands are parsed against an explicit allowlist only.'),
        );
        break;
      case 'date':
        nextLines.push(line(new Date().toLocaleString()));
        break;
      case 'whoami':
        nextLines.push(line(USERNAME));
        break;
      case 'pwd':
        nextLines.push(line(PROMPT_PATH));
        break;
      case 'ls':
        nextLines.push(line(FILES.join('    ')));
        break;
      case 'theme': {
        const requested = args[0]?.toLowerCase();
        if (!requested) {
          nextLines.push(line(`Current theme: ${preferences.theme}`));
          break;
        }
        if (requested !== 'aurora' && requested !== 'midnight') {
          nextLines.push(line(`Unknown theme "${requested}". Use aurora or midnight.`, 'error'));
          break;
        }
        updatePreferences({ theme: requested });
        nextLines.push(line(`Theme switched to ${requested}.`, 'meta'));
        break;
      }
      default:
        nextLines.push(line(`Command not found: ${normalized}`, 'error'));
        nextLines.push(line('Run "help" to see the supported browser-safe command set.', 'meta'));
        break;
    }

    append(nextLines);
  };

  const handleSubmit = () => {
    runCommand(input);
    if (input.trim()) {
      setHistory((current) => [...current, input]);
    }
    setInput('');
    setHistoryIndex(null);
    setHistoryDraft('');
  };

  const handleHistoryKey = (direction: 'up' | 'down') => {
    if (history.length === 0) return;

    if (direction === 'up') {
      if (historyIndex === null) {
        setHistoryDraft(input);
        setHistoryIndex(history.length - 1);
        setInput(history.at(-1) ?? '');
        return;
      }
      const nextIndex = Math.max(0, historyIndex - 1);
      setHistoryIndex(nextIndex);
      setInput(history[nextIndex] ?? '');
      return;
    }

    if (historyIndex === null) return;

    const nextIndex = historyIndex + 1;
    if (nextIndex >= history.length) {
      setHistoryIndex(null);
      setInput(historyDraft);
      return;
    }

    setHistoryIndex(nextIndex);
    setInput(history[nextIndex] ?? '');
  };

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateRows: 'auto 1fr auto',
        width: '100%',
        height: '100%',
        minHeight: 0,
        background: TERMINAL_THEME_BG[preferences.theme],
        color: TERMINAL_TEXT[preferences.theme],
      }}
      onClick={() => inputRef.current?.focus()}
    >
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: 16,
          padding: '18px 20px',
          borderBottom: `1px solid ${preferences.theme === 'aurora' ? 'rgba(77, 89, 124, 0.14)' : 'rgba(157, 179, 226, 0.12)'}`,
          background: preferences.theme === 'aurora' ? 'rgba(255,255,255,0.55)' : 'rgba(7,11,22,0.72)',
          backdropFilter: 'blur(18px)',
        }}
      >
        <div style={{ display: 'grid', gap: 6 }}>
          <strong style={{ display: 'inline-flex', alignItems: 'center', gap: 10, fontSize: 20 }}>
            <TerminalSquare size={20} />
            Terminal
          </strong>
          <span style={{ fontSize: 13, color: TERMINAL_MUTED[preferences.theme] }}>
            Safe command interpreter with local history and theme control.
          </span>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 12px',
              borderRadius: 999,
              background: TERMINAL_PANEL[preferences.theme],
              border: `1px solid ${preferences.theme === 'aurora' ? 'rgba(77, 89, 124, 0.14)' : 'rgba(157, 179, 226, 0.12)'}`,
              fontSize: 12.5,
              color: TERMINAL_MUTED[preferences.theme],
            }}
          >
            <ShieldCheck size={14} />
            Allowlist only
          </span>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 12px',
              borderRadius: 999,
              background: TERMINAL_PANEL[preferences.theme],
              border: `1px solid ${preferences.theme === 'aurora' ? 'rgba(77, 89, 124, 0.14)' : 'rgba(157, 179, 226, 0.12)'}`,
              fontSize: 12.5,
              color: TERMINAL_MUTED[preferences.theme],
            }}
          >
            <Command size={14} />
            ↑ ↓ history
          </span>
        </div>
      </header>

      <div
        ref={scrollRef}
        style={{
          overflowY: 'auto',
          padding: 20,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontSize: 14,
          lineHeight: 1.7,
        }}
      >
        <div
          style={{
            minHeight: '100%',
            padding: 18,
            borderRadius: 24,
            background: TERMINAL_PANEL[preferences.theme],
            border: `1px solid ${preferences.theme === 'aurora' ? 'rgba(77, 89, 124, 0.16)' : 'rgba(157, 179, 226, 0.12)'}`,
            boxShadow: preferences.theme === 'aurora' ? '0 24px 48px rgba(73, 88, 129, 0.12)' : '0 28px 60px rgba(0, 0, 0, 0.3)',
          }}
        >
          {lines.map((entry) => (
            <div key={entry.id} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {entry.input !== undefined ? (
                <div>
                  <span style={{ color: accent }}>{entry.prompt}</span>
                  <span style={{ color: TERMINAL_MUTED[preferences.theme] }}>:</span>
                  <span style={{ color: accent }}>{PROMPT_PATH}</span>
                  <span style={{ color: TERMINAL_MUTED[preferences.theme] }}>$ </span>
                  <span>{entry.input}</span>
                </div>
              ) : (
                <div
                  style={{
                    color:
                      entry.kind === 'error'
                        ? '#FF8C8C'
                        : entry.kind === 'meta'
                          ? TERMINAL_MUTED[preferences.theme]
                          : TERMINAL_TEXT[preferences.theme],
                  }}
                >
                  {entry.text}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <footer
        style={{
          padding: '0 20px 20px',
        }}
      >
        <label
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr auto',
            alignItems: 'center',
            gap: 12,
            padding: '14px 16px',
            borderRadius: 22,
            background: TERMINAL_PANEL[preferences.theme],
            border: `1px solid ${preferences.theme === 'aurora' ? 'rgba(77, 89, 124, 0.14)' : 'rgba(157, 179, 226, 0.12)'}`,
          }}
        >
          <span style={{ color: accent, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}>{prompt}</span>
          <input
            ref={inputRef}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                handleSubmit();
                return;
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault();
                handleHistoryKey('up');
                return;
              }
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                handleHistoryKey('down');
              }
            }}
            placeholder='Try "help" or "theme midnight"'
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            style={{
              width: '100%',
              border: 'none',
              outline: 'none',
              background: 'transparent',
              color: TERMINAL_TEXT[preferences.theme],
              fontSize: 14,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            }}
          />
          <button
            type="button"
            onClick={handleSubmit}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 14px',
              borderRadius: 14,
              border: 'none',
              background: accent,
              color: '#111827',
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            <ArrowDownToLine size={15} />
            Run
          </button>
        </label>
      </footer>
    </div>
  );
}
