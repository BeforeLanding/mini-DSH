import type { EventData } from './contracts.js'
export class StreamJournal {
  content = ''
  reasoningContent = ''
  #content = ''
  #reasoning = ''
  #closed = false
  #timer: ReturnType<typeof setInterval>
  constructor(private requestId: string, private emit: (data: EventData['model/fragment']) => void) {
    this.#timer = setInterval(() => this.flush(), 250)
    this.#timer.unref()
  }
  add(kind: 'content' | 'reasoning', chunk: string) {
    if (this.#closed) return
    if (kind === 'content') { this.content += chunk; this.#content += chunk }
    else { this.reasoningContent += chunk; this.#reasoning += chunk }
    if (Buffer.byteLength(this.#content) + Buffer.byteLength(this.#reasoning) >= 4096) this.flush()
  }
  flush() {
    if (!this.#content && !this.#reasoning) return
    this.emit({ requestId: this.requestId, content: this.#content, reasoningContent: this.#reasoning })
    this.#content = ''; this.#reasoning = ''
  }
  close() { if (this.#closed) return; clearInterval(this.#timer); this.flush(); this.#closed = true }
}
