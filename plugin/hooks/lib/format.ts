// Idioma e formatação do que a pessoa lê (relatórios, diagnóstico, popups). O que só o modelo lê fica em inglês.

export type Lang = 'en' | 'pt' | 'es'

export const LANGS: readonly Lang[] = ['en', 'pt', 'es']

const LOCALES: Record<Lang, string> = { en: 'en-US', pt: 'pt-BR', es: 'es-ES' }

export const LANG_NAMES: Record<Lang, string> = { en: 'English', pt: 'Português', es: 'Español' }

/**
 * Idioma suportado de um valor de configuração: locale (`pt-BR`, `pt_BR.UTF-8`, `es`) ou nome livre como o
 * `language` do Claude Code (`portuguese`, `spanish`). null quando o valor está vazio ou não é suportado.
 */
export function langFrom(value: unknown): Lang | null {
  const v = String(value ?? '').trim().toLowerCase()
  if (!v || v === 'auto' || v === 'c' || v === 'posix') return null
  if (/^(pt|por)([-_.@]|$)|portugu/.test(v)) return 'pt'
  if (/^(es|spa)([-_.@]|$)|spanish|espa[ñn]ol|castellano/.test(v)) return 'es'
  if (/^(en|eng)([-_.@]|$)|english|ingl[eé]s/.test(v)) return 'en'
  return null
}

// O Intl separa moeda e número com espaço inseparável; no terminal ele desalinha colunas em algumas fontes
const plainSpaces = (text: string): string => text.replace(/[  ]/g, ' ')

export type Fmt = {
  lang: Lang
  /** Valor em dólares no formato do idioma: $1.20, US$ 1,20, 1,20 US$. */
  money: (value: number, digits?: number) => string
  /** Inteiro com separador de milhar. */
  int: (value: number) => string
  /** Contagem curta de tokens: 739k / 739 mil, 369.3M / 369,3 mi. */
  tokens: (value: number) => string
  /** Fração como porcentagem inteira. */
  pct: (fraction: number) => string
  /** Dia `AAAA-MM-DD` por extenso curto: Jul 1, 2026 / 1 de jul. de 2026. */
  date: (key: string) => string
}

export function formatter(lang: Lang): Fmt {
  const locale = LOCALES[lang]
  const safe = (format: () => string, fallback: () => string): string => {
    try {
      return plainSpaces(format())
    } catch {
      return fallback()
    }
  }
  return {
    lang,
    money: (value, digits = 2) =>
      safe(
        () => new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value),
        () => `$${value.toFixed(digits)}`,
      ),
    int: value => safe(() => new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value), () => String(Math.round(value))),
    tokens: value =>
      safe(
        () => new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(value),
        () => (Math.abs(value) >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : Math.abs(value) >= 1e3 ? `${Math.round(value / 1e3)}k` : String(Math.round(value))),
      ),
    pct: fraction => safe(() => new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(fraction), () => `${Math.round(fraction * 100)}%`),
    date: key => {
      const [y, m, d] = key.split('-').map(Number)
      return safe(() => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(y, m - 1, d)), () => key)
    },
  }
}

/** Título com régua embaixo, do tamanho do texto. */
export function heading(text: string): string[] {
  return [text, '─'.repeat(Math.min(80, [...text].length))]
}

/**
 * Tabela em texto: colunas alinhadas, recuo de 2 espaços e 3 entre colunas. `right[i]` alinha a coluna i à
 * direita (números). A primeira linha é o cabeçalho quando `header` é verdadeiro.
 */
export function table(rows: string[][], right: boolean[], header = true): string[] {
  const widths = rows[0].map((_, i) => Math.max(...rows.map(r => [...(r[i] ?? '')].length)))
  const line = (row: string[]) =>
    '  ' +
    row
      .map((cell, i) => {
        const pad = ' '.repeat(widths[i] - [...cell].length)
        return right[i] ? pad + cell : i === row.length - 1 ? cell : cell + pad
      })
      .join('   ')
      .trimEnd()
  const out = rows.map(line)
  if (header && rows.length > 1) out.splice(1, 0, '  ' + widths.map(w => '─'.repeat(w)).join('   '))
  return out
}

/** Quebra `text` em linhas de até `width` colunas, com `indent` na frente de cada uma. */
export function wrap(text: string, width: number, indent = ''): string[] {
  const max = Math.max(30, width - indent.length)
  const out: string[] = []
  let current = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (current && current.length + 1 + word.length > max) {
      out.push(indent + current)
      current = word
    } else {
      current = current ? `${current} ${word}` : word
    }
  }
  if (current) out.push(indent + current)
  return out
}

/** Item de lista com a quebra alinhada depois do marcador. */
export function bullet(marker: string, text: string, width: number): string[] {
  const lines = wrap(text, width - 4 - [...marker].length)
  return lines.map((line, i) => (i === 0 ? `  ${marker} ${line}` : `  ${' '.repeat([...marker].length)} ${line}`))
}
