import { useId, useState, type KeyboardEvent } from "react";

export type SelectChoice = { id: string; name: string };

/** One field for both searching and selecting a directory identity. Free text is never a selection. */
export function SearchableSelect({ label, value, options, query, onQueryChange, onChange, loading = false, disabled = false, placeholder = "搜索名称或 ID", maxLength = 100 }: {
  label: string; value: string; options: readonly SelectChoice[]; query: string;
  onQueryChange: (query: string) => void; onChange: (id: string) => void;
  loading?: boolean; disabled?: boolean; placeholder?: string; maxLength?: number;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState("");
  const [selected, setSelected] = useState<SelectChoice>();
  const active = options.find(row => row.id === highlighted) ?? options[0];
  const choice = options.find(row => row.id === value) ?? (selected?.id === value ? selected : undefined);
  const expanded = open && !disabled;
  function choose(row: SelectChoice) {
    setSelected(row); onChange(row.id); setOpen(false); setHighlighted("");
  }
  function begin() {
    if (disabled || open) return;
    setOpen(true); setHighlighted(""); onQueryChange("");
  }
  function keyboard(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape" && expanded) {
      event.preventDefault(); event.stopPropagation(); setOpen(false); return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!expanded) { begin(); return; }
      const index = options.findIndex(row => row.id === active?.id);
      const next = options[Math.max(0, Math.min(options.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))];
      if (next) { setHighlighted(next.id); document.getElementById(id + "-" + next.id)?.scrollIntoView({ block: "nearest" }); }
    } else if (event.key === "Enter" && expanded) {
      event.preventDefault(); if (!loading && active) choose(active);
    }
  }
  return <div className="cp-field console-combobox">
    <span id={id + "-label"}>{label}</span>
    <input role="combobox" aria-labelledby={id + "-label"} aria-expanded={expanded}
      aria-controls={id + "-list"} aria-autocomplete="list"
      aria-activedescendant={expanded && !loading && active ? id + "-" + active.id : undefined}
      autoComplete="off" maxLength={maxLength} disabled={disabled}
      value={expanded ? query : choice?.name ?? ""}
      placeholder={placeholder}
      onFocus={begin} onClick={begin} onBlur={() => setOpen(false)} onKeyDown={keyboard}
      onChange={event => { setOpen(true); setHighlighted(""); onChange(""); onQueryChange(event.target.value); }} />
    {expanded && <div className="console-combobox-popup">
      <div role="listbox" id={id + "-list"} aria-labelledby={id + "-label"} aria-busy={loading}>
        {!loading && options.map(row => <div role="option" aria-selected={row.id === value}
          id={id + "-" + row.id} key={row.id}
          className={"console-combobox-option" + (row.id === active?.id ? " highlighted" : "")}
          onMouseEnter={() => setHighlighted(row.id)}
          onMouseDown={event => event.preventDefault()} onClick={() => choose(row)}>
          <strong>{row.name}</strong><small>{row.id}</small>
        </div>)}
      </div>
      {loading && <div className="console-combobox-status" role="status">正在读取…</div>}
      {!loading && !options.length && <div className="console-combobox-status" role="status">没有匹配对象</div>}
    </div>}
  </div>;
}
