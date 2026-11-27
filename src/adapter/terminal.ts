import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { jsx, signal, type KeyEvent } from "@oh-my-pi/pi-tui";
import type { SessionInfo } from "../vendor/pi-intercom/types.ts";
import { sessionLabel } from "./messaging.ts";

export interface PickerItem<T> {
  label: string;
  detail?: string;
  value: T;
}

export function pick<T>(
  ctx: ExtensionContext,
  options: {
    title: string;
    items: PickerItem<T>[];
    action: string;
    initialIndex?: number;
    handoverKey?: boolean;
    signal: AbortSignal;
  },
): Promise<{ value: T; handover: boolean } | undefined> {
  const items = options.items.map(({ label, detail }, index) => ({ id: String(index), label, detail }));
  const selected = signal(items[options.initialIndex ?? 0]?.id ?? items[0]?.id ?? null);
  return ctx.ui.custom<{ value: T; handover: boolean } | undefined>((_ui, _theme, _keys, done) => {
    const activate = (id: string | null, handover = false) => {
      const item = id === null ? undefined : options.items[Number(id)];
      if (item) done({ value: item.value, handover });
    };
    return jsx("picker", {
      title: options.title,
      noun: "sessions",
      size: "md",
      layout: "rows",
      preview: "none",
      query: null,
      confirm: null,
      items,
      empty: "No other Intercom sessions connected",
      selected,
      actions: [
        { id: "choose", label: options.action, keys: ["enter"], primary: true, disabled: items.length === 0 },
        ...(options.handoverKey ? [{ id: "handover", label: "Hand over", keys: ["h"], disabled: items.length === 0 }] : []),
        { id: "close", label: "Close", keys: ["esc"], end: true },
      ],
      onSelect: (id: string) => selected.set(id),
      onActivate: (id: string) => activate(id),
      onAction: (action: string) => {
        if (action === "close") done(undefined);
        if (action === "choose" || action === "handover") activate(selected(), action === "handover");
      },
    }, "roster");
  }, { overlay: true, signal: options.signal });
}

export function sessionItem(peer: SessionInfo): PickerItem<SessionInfo> {
  return {
    label: peer.name ? `${sessionLabel(peer)} (${peer.id.slice(0, 8)})` : peer.id,
    detail: [peer.cwd, peer.model, peer.status, peer.contextPct === undefined ? undefined : `${peer.contextPct}% context`]
      .filter(Boolean).join(" · "),
    value: peer,
  };
}

export async function showProgress<T>(
  ctx: ExtensionContext,
  signal: AbortSignal,
  label: string,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T | undefined> {
  const cancellation = new AbortController();
  const combined = AbortSignal.any([signal, cancellation.signal]);
  try {
    const result = await ctx.ui.custom<{ value: T } | { error: unknown } | undefined>((_ui, _theme, _keys, done) => {
      void operation(combined).then(
        value => { if (!combined.aborted) done({ value }); },
        error => { if (!combined.aborted) done({ error }); },
      );
      return jsx("col", {
        onKey: (key: KeyEvent) => {
          if (key.id !== "escape" && key.id !== "ctrl+c") return false;
          cancellation.abort();
          done(undefined);
          return true;
        },
        children: [
          jsx("spinner", { label }),
          jsx("text", { spans: [{ t: "Esc to cancel", s: "muted" }] }),
        ],
      });
    }, { signal });
    if (result && "error" in result) throw result.error;
    return result?.value;
  } finally {
    cancellation.abort();
  }
}
