// Variable store for interactive player

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export class VariableStore {
  private vars: Map<string, string> = new Map()
  private listeners: Map<string, Set<(value: string) => void>> = new Map()

  set(name: string, value: string): void {
    this.vars.set(name, value)
    const handlers = this.listeners.get(name)
    if (handlers) {
      handlers.forEach((h) => h(value))
    }
  }

  get(name: string): string | undefined {
    return this.vars.get(name)
  }

  getAll(): Record<string, string> {
    return Object.fromEntries(this.vars)
  }

  /**
   * Replace {varName} tokens in HTML with current variable values.
   *
   * Values originate from end-user form input and are interpolated into the
   * scene's srcdoc, which runs with allow-scripts. Without escaping, a viewer
   * typing `</script><script>…` into a form field would get arbitrary script
   * executed in the embed. HTML-escape every value so it
   * lands as inert text / attribute content.
   */
  interpolate(html: string): string {
    let result = html
    for (const [name, value] of this.vars) {
      result = result.replaceAll(`{${name}}`, escapeHtml(value))
    }
    return result
  }

  onChange(name: string, handler: (value: string) => void): () => void {
    if (!this.listeners.has(name)) {
      this.listeners.set(name, new Set())
    }
    this.listeners.get(name)!.add(handler)
    return () => {
      this.listeners.get(name)?.delete(handler)
    }
  }

  clear(): void {
    this.vars.clear()
    this.listeners.clear()
  }
}
