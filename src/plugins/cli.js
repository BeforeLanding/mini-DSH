import readline from 'node:readline'

export const name = 'mini-cli'
export const inject = ['sessions', 'agents', 'agentLoop', 'tools', 'systemPrompt', 'llm']
export function apply(ctx, config = {}) {
  const session = ctx.sessions.create({ source: 'cli' })
  const agent = ctx.agents.create({ name: 'cli-agent', sessionId: session.id,
    model: config.model ?? ctx.llm.defaultSelection(), loop: ctx.agentLoop })
  ctx.effect(() => {
    const input = config.input ?? process.stdin
    const output = config.output ?? process.stdout
    const rl = readline.createInterface({ input, output, terminal: Boolean(input.isTTY && output.isTTY) })
    const color = (code, text) => output.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text
    const print = text => output.write(`${text}\n`)
    let controller
    let running = false
    let closed = false
    let exiting = false
    let queue = Promise.resolve()
    const prompt = () => { if (!closed) { rl.setPrompt('User > '); rl.prompt() } }
    const escape = chunk => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (running && bytes.length === 1 && bytes[0] === 0x1b) controller?.abort()
    }
    input.on('data', escape)
    print('mini-dsh — a local agent Harness')
    print('Commands: /tools /models /model /history /prompt /reset /exit')
    print('Press Esc to cancel a run.')
    print(`Model: ${agent.model}`)
    async function handle(line) {
      const text = line.trim()
      if (!text || exiting) return
      if (text.startsWith('/')) {
        const [command, ...parts] = text.split(/\s+/)
        switch (command) {
          case '/tools': print(ctx.tools.list().map(tool => `${tool.name}: ${tool.description ?? ''}`).join('\n') || '(no tools)'); break
          case '/models': print(ctx.llm.models().join('\n')); break
          case '/model': {
            const selection = parts.join(' ')
            if (!selection) print(agent.model)
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
        print(controller.signal.aborted ? '[cancelled]' : `[AgentError] ${error.message}`)
      } finally { controller = undefined; running = false }
    }
    rl.on('line', line => {
      queue = queue.then(() => handle(line)).catch(error => print(`[CLIError] ${error.message}`)).finally(prompt)
    })
    rl.on('close', () => {
      closed = true
      void queue.finally(() => ctx.root.fiber.dispose())
    })
    prompt()
    return () => { closed = true; controller?.abort(); input.off('data', escape); rl.close() }
  }, 'run cli')
}
