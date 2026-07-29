import { ArrowLeft } from "./Icons.js";

/**
 * The live-model connection, on its own screen rather than as a form wedged
 * above the thread. You touch it once; the transcript is what you look at
 * afterwards — so the composer states the connection in a chip and this is
 * what the chip opens.
 */

/** Shortcuts, not a whitelist: the field is what actually gets sent. */
const PRESETS = [
  "anthropic/claude-sonnet-4.5",
  "openai/gpt-4o-mini",
  "google/gemini-2.5-flash",
] as const;

export function ConnectionSettings(props: {
  apiKey: string;
  model: string;
  remember: boolean;
  onApiKey: (value: string) => void;
  onModel: (value: string) => void;
  onRemember: (value: boolean) => void;
  onBack: () => void;
}) {
  return (
    <div className="subview">
      <div className="subview-head">
        <button className="iconbtn" onClick={props.onBack} aria-label="Back to the transcript">
          <ArrowLeft size={15} />
        </button>
        <span className="subview-title">Connection</span>
        <span className="subview-meta">{props.apiKey ? "key set" : "no key"}</span>
      </div>

      <div className="subview-body">
        <p className="subview-lead">
          The live driver is a plain tool-calling loop in this example's own code — the library
          never talks to a provider. Your key stays in this browser and is sent only to
          openrouter.ai. Never used in CI.
        </p>

        <div className="form-row">
          <label htmlFor="llm-key">OpenRouter API key</label>
          <input
            id="llm-key"
            className="input"
            type="password"
            placeholder="sk-or-…"
            value={props.apiKey}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => props.onApiKey(e.target.value)}
          />
          <label className="toggle" style={{ marginTop: 4 }}>
            <input
              type="checkbox"
              checked={props.remember}
              onChange={(e) => props.onRemember(e.target.checked)}
            />
            Remember in this browser
          </label>
          <p className="form-hint">
            Or set <code className="u-mono">VITE_OPENROUTER_API_KEY</code> in{" "}
            <code className="u-mono">.env.local</code>. Get one at{" "}
            <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">
              openrouter.ai/keys
            </a>
            .
          </p>
        </div>

        <div className="form-row">
          <label htmlFor="llm-model">Model</label>
          <input
            id="llm-model"
            className="input"
            value={props.model}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => props.onModel(e.target.value)}
          />
          <div className="model-list">
            {PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                aria-pressed={props.model === preset}
                onClick={() => props.onModel(preset)}
              >
                {preset}
              </button>
            ))}
          </div>
          <p className="form-hint">
            Any OpenRouter model id works, as long as it supports tool calling.
          </p>
        </div>
      </div>
    </div>
  );
}
