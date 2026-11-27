import en from "./en.json" with { type: "json" };
import zhCN from "./zh-CN.json" with { type: "json" };

type MessageKey = keyof typeof en;
type Values = Readonly<Record<string, string | number>>;
export type Translate = (key: MessageKey, values?: Values) => string;

const catalogs: Record<string, Partial<Record<MessageKey, string>>> = { en, "zh-CN": zhCN };
const placeholders = /\{(\w+)\}/g;
const placeholderSignature = (text: string) => [...text.matchAll(placeholders)].map(match => match[0]).sort().join();

export function createTranslator(env: NodeJS.ProcessEnv = process.env): Translate {
  const locale = [env.OMP_INTERCOM_LOCALE, env.LC_ALL, env.LC_MESSAGES, env.LANG].find(value => value?.trim());
  const tag = locale?.trim().split(/[.@]/, 1)[0]?.replaceAll("_", "-").toLowerCase() ?? "";
  const language = /^(?:zh(?:-cn|-sg)?|zh-hans(?:-[a-z0-9]+)*)$/.test(tag) ? "zh-CN" : "en";
  const catalog = catalogs[language]!;

  return (key, values) => {
    const source = en[key];
    const translated = catalog[key];
    const template = translated && placeholderSignature(translated) === placeholderSignature(source) ? translated : source;
    return template.replace(placeholders, (placeholder, name: string) =>
      values && Object.hasOwn(values, name) ? String(values[name]) : placeholder,
    );
  };
}

export const english = createTranslator({});
