import {
  memoryTranscriptDigest,
  parseProjectMemoryEvaluation,
  projectMemoryEvaluationPrompt
} from '../src/main/backends/memory.ts'

const ok = (condition, message) => {
  if (!condition) throw new Error(message)
}

const transcript = [
  { role: 'user', text: 'Use same-level chats. There is no Main chat.', at: 1 },
  { role: 'assistant', text: 'Implemented peer chats.', at: 2 }
]

const digest = memoryTranscriptDigest(transcript)
ok(digest.includes('User: Use same-level chats'), 'digest includes user decisions')
ok(digest.includes('Assistant: Implemented peer chats'), 'digest includes completed outcomes')

const prompt = projectMemoryEvaluationPrompt('- Use a Main chat.', transcript)
ok(prompt?.includes('CURRENT MEMORY'), 'prompt includes current authoritative memory')
ok(prompt?.includes('credentials, secrets, tokens'), 'prompt excludes sensitive data')
ok(prompt?.includes('Remove or replace'), 'prompt allows explicit reversals')

ok(
  parseProjectMemoryEvaluation('{"memory":null}', '- Existing') === null,
  'null means no material update'
)
ok(
  parseProjectMemoryEvaluation(
    '```json\n{"memory":"# Decisions\\n\\n- Chats are peers."}\n```',
    '- Existing'
  ) === '# Decisions\n\n- Chats are peers.',
  'fenced JSON is accepted and yields complete markdown'
)
ok(
  parseProjectMemoryEvaluation('{"memory":"   "}', '- Existing') === null,
  'an evaluator cannot erase memory with an empty result'
)
ok(
  parseProjectMemoryEvaluation('not json', '- Existing') === null,
  'malformed model output fails closed'
)

console.log('PROJECT-MEMORY-EVALUATION OK — bounded, conservative, structured')
