import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { jsx, signal, type KeyEvent } from "@oh-my-pi/pi-tui";
import type { Translate } from "../i18n/index.ts";
import type { SessionInfo } from "../vendor/pi-intercom/types.ts";
import { sessionLabel } from "./messaging.ts";

export interface PickerItem<T> {
  label: string;
  detail?: string;
  value: T;
}

export function pick<T>(
  ctx: ExtensionContext,
  t: Translate,
  options: {
    title: string;
    items: PickerItem<T>[];
    action: string;
    initialIndex?: number;
    handoverKey?: boolean;
    signal: AbortSignal;
  },
): Promise<{ value: T; action: "choose" | "handover" | "next-task" } | undefined> {
  const items = options.items.map(({ label, detail }, index) => ({ id: String(index), label, detail }));
  const selected = signal(items[options.initialIndex ?? 0]?.id ?? items[0]?.id ?? null);
  return ctx.ui.custom<{ value: T; action: "choose" | "handover" | "next-task" } | undefined>((_ui, _theme, keys, done) => {
    const activate = (id: string | null, action: "choose" | "handover" | "next-task" = "choose") => {
      const item = id === null ? undefined : options.items[Number(id)];
      if (item) done({ value: item.value, action });
    };
    return jsx("picker", {
      title: options.title,
      noun: t("sessions"),
      size: "md",
      layout: "rows",
      preview: "none",
      query: null,
      confirm: null,
      items,
      empty: t("emptyRoster"),
      selected,
      actions: [
        { id: "choose", label: options.action, keys: ["enter"], primary: true, disabled: items.length === 0 },
        ...(options.handoverKey ? [
          { id: "handover", label: t("handOver"), keys: ["h"], disabled: items.length === 0 },
          { id: "next-task", label: t("nextTask"), keys: ["shift", "tab"], disabled: items.length === 0 },
        ] : []),
        { id: "close", label: t("close"), keys: ["esc"], end: true },
      ],
      onKey: (key: KeyEvent) => {
        if (!options.handoverKey || key.kind === "release" || !keys.matches(key, "tui.input.tab")) return false;
        activate(selected());
        return true;
      },
      onSelect: (id: string) => selected.set(id),
      onActivate: (id: string) => activate(id),
      onAction: (action: string) => {
        if (action === "close") done(undefined);
        if (action === "choose" || action === "handover" || action === "next-task") activate(selected(), action);
      },
    }, "roster");
  }, { overlay: true, signal: options.signal });
}

export function sessionItem(peer: SessionInfo, t: Translate): PickerItem<SessionInfo> {
  const status = peer.status;
  return {
    label: peer.name ? `${sessionLabel(peer)} (${peer.id.slice(0, 8)})` : peer.id,
    detail: [peer.cwd, peer.model,
      status === "idle" || status === "busy" || status === "thinking" ? t(status) : status,
      peer.contextPct === undefined ? undefined : t("contextUsage", { percent: peer.contextPct })]
      .filter(Boolean).join(" · "),
    value: peer,
  };
}

export async function showProgress<T>(
  ctx: ExtensionContext,
  t: Translate,
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
          jsx("text", { spans: [{ t: t("cancelProgress"), s: "muted" }] }),
        ],
      });
    }, { signal });
    if (result && "error" in result) throw result.error;
    return result?.value;
  } finally {
    cancellation.abort();
  }
}
