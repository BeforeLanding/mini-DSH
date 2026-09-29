import type { ReadStream, WriteStream } from 'node:tty'
import type { Context } from '@deepseek-ai/cordis'
import readline from 'node:readline'

export const name = 'mini-cli'
export const inject = ['sessions', 'agents', 'agentLoop', 'tools', 'systemPrompt', 'llm', 'sandbox']

// The apply function registers the CLI plugin with the mini-DSH context, setting up the necessary interfaces and event handlers for command-line interaction.
export function apply(ctx: Context, config: { model?: string; input?: ReadStream; output?: WriteStream } = {}) {
  const session = ctx.sessions.create({ source: 'cli' })
  const agent = ctx.agents.create({ name: 'cli-agent', sessionId: session.id,
    model: config.model ?? ctx.llm.defaultSelection(), loop: ctx.agentLoop })
    
  ctx.effect(() => {
    const input = config.input ?? process.stdin
    const output = config.output ?? process.stdout
    const rl = readline.createInterface({ input, output, terminal: Boolean(input.isTTY && output.isTTY) })
    const color = (code: number, text: string) => output.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text
    const print = (text: unknown) => { output.write(`${text}\n`) }
    let controller: AbortController | undefined
    let running = false
    let closed = false
    let exiting = false
    let approval: ((answer: string) => void) | undefined
    let queue = Promise.resolve()
    const prompt = () => { if (!closed) { rl.setPrompt('User > '); rl.prompt() } }
    const escape = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (running && bytes.length === 1 && bytes[0] === 0x1b) controller?.abort()
    }
    input.on('data', escape)
    print('mini-dsh — a local agent Harness')
    print('Commands: /tools /models /model /history /prompt /reset /exit')
    print(`Sandbox workspace: ${ctx.sandbox.workspace}`)
    print('Writes and bash execution ask [Y/n] first. Press Esc to cancel a run.')
    print(`Model: ${agent.model}`)
    const disposeApprover = ctx.sandbox.setApprover(request => new Promise(resolve => {
      if (closed) { resolve(false); return }
      running = false
      print(request.summary)
      approval = answer => {
        approval = undefined
        running = true
        const allowed = /^(?:y|yes)?$/i.test(answer.trim())
        if (!allowed) print('rejected.')
        resolve(allowed)
      }
      rl.setPrompt('Allow this? [Y/n] ')
      rl.prompt()
    }))
    async function handle(line: string) {
      const text = line.trim()
      if (!text || exiting) return
      if (text.startsWith('/')) {
        const [command, ...parts] = text.split(/\s+/)
        switch (command) {
          case '/tools': print(ctx.tools.list().map(tool => `${tool.name}: ${tool.description ?? ''}`).join('\n') || '(no tools)'); break
          case '/models': print(ctx.llm.models().join('\n')); break
          case '/model': {
            const selection = parts.join(' ')
            if (!selection) print(String(agent.model))
            else if (!ctx.llm.has(selection)) print(`Unknown model: ${selection}`)
            else { agent.model = selection; print(`Model: ${selection}`) }
            break
          }
          case '/history': print(JSON.stringify(ctx.sessions.get(session.id).events, null, 2)); break
          case '/prompt': print(await ctx.systemPrompt.assemble({ agent, sessionId: session.id })); break
          case '/reset': ctx.sessions.clear(session.id); print(`Session reset: ${session.id}`); break
          case '/exit': exiting = true; rl.close(); return
          default: print(`Unknown command: ${command}`)
        }
        return
      }
      controller = new AbortController()
      running = true
      let segment = ''
      let streamed = false
      const endSegment = () => { if (segment) output.write('\n'); segment = '' }
      try {
        const answer = await agent.send(text, {
          signal: controller.signal,
          onReasoning(chunk) {
            if (segment !== 'thinking') { endSegment(); output.write(color(90, '[Thinking] ')); segment = 'thinking' }
            output.write(color(90, chunk))
          },
          onContent(chunk) {
            streamed = true
            if (segment !== 'content') { endSegment(); output.write('Agent > '); segment = 'content' }
            output.write(chunk)
          },
          onToolCall(call) { endSegment(); print(color(36, `[Tool] ${call.name} ${JSON.stringify(call.arguments)}`)) },
          onToolResult(result) { endSegment(); print(color(32, `[Result] ${result.renderedContent.slice(0, 300)}`)) },
        })
        endSegment()
        if (!streamed) print(`Agent > ${answer}`)
      } catch (error) {
        endSegment()
        print(controller.signal.aborted ? '[cancelled]' : `[AgentError] ${error instanceof Error ? error.message : String(error)}`)
      } finally { controller = undefined; running = false }
    }
    rl.on('line', line => {
      // Piped input can retain key bytes that a terminal normally consumes.
      line = line.replace(/\x1b(?:\[[0-9;]*[A-Za-z])?/g, '')
      if (approval) { approval(line); return }
      queue = queue.then(() => handle(line)).catch(error => print(`[CLIError] ${error instanceof Error ? error.message : String(error)}`)).finally(prompt)
    })
    rl.on('close', () => {
      closed = true
      approval?.('n')
      void queue.finally(() => ctx.root.fiber.dispose())
    })
    prompt()
    return () => {
      closed = true
      disposeApprover()
      approval?.('n')
      controller?.abort()
      input.off('data', escape)
      rl.close()
    }
  }, 'run cli')
}
