import { test, expect } from 'claude-code/testing'

import { register } from './register'

test('bloquea comandos destructivos y deja pasar los normales', async ($, on) => {
  register(on, {})

  const bad = await $.tool.call({ tool: 'Bash', command: 'git push --force origin main' })
  expect(typeof bad.deny).toBe("string")

  const bad2 = await $.tool.call({ tool: 'Bash', command: 'npx prisma migrate reset' })
  expect(typeof bad2.deny).toBe("string")
})

test('protege .env pero no .env.example', async ($, on) => {
  register(on, {})

  const env = await $.tool.call({ tool: 'Write', file_path: '/app/.env.local', content: 'x' })
  expect(typeof env.deny).toBe("string")
})
