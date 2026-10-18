// Runs the known vectors (vectors.json, generated with Foundry cast) against shared/abi.js.
// Used by abi.test.mjs (node --test) and index.html (the same checks in a browser). Returns [{ name, ok, got, want }].
export function runVectors(A, V) {
  const out = []
  const check = (name, got, want) => out.push({ name, ok: String(got).toLowerCase() === String(want).toLowerCase(), got, want })
  for (const e of V.encode) check(`encodeAnswer(${e.format}, ${e.input.slice(0, 24)})`, A.encodeAnswer(e.format, e.input), e.bytes32)
  for (const e of V.encode) check(`decode→encode round trip ${e.format}`, A.encodeAnswer(e.format, A.decodeAnswer(e.format, e.bytes32)), e.bytes32)
  for (const r of V.reject) {
    let threw = false
    try { A.encodeAnswer(r.format, r.input) } catch { threw = true }
    check(`rejects ${r.format} "${r.input.slice(0, 24)}"`, threw, true)
  }
  for (const h of V.answerHash) check(`answerHash(${h.id})`, A.answerHash(h.id, h.answer, V.salt), h.hash)
  for (const h of V.commitHash) check(`commitHash(${h.id})`, A.commitHash(h.id, V.solver, h.answer, V.nonce), h.hash)
  for (const h of V.commitHash) check(`commitHash(${h.id}) lowercase solver`, A.commitHash(h.id, V.solver.toLowerCase(), h.answer, V.nonce), h.hash)
  for (const m of V.modelTag) { check(`modelTag(${m.model})`, A.modelTag(m.model), m.bytes32); check(`modelFromTag`, A.modelFromTag(m.bytes32), m.model) }
  check('textHash(question object)', A.textHash(V.textHash.question), V.textHash.hash)
  const shuffled = Object.fromEntries(Object.entries(V.textHash.question).reverse())
  check('textHash ignores key order of the input object', A.textHash(shuffled), V.textHash.hash)
  check('textHash(canonical string)', A.textHash(A.canonicalQuestion(V.textHash.question)), V.textHash.hash)
  for (const [sig, sel] of Object.entries(V.selectors)) check(`selector ${sig}`, A.selector(sig), sel)
  for (const [n, t] of Object.entries(V.topics)) check(`topic0 ${n}`, A.EVENTS[n], t)
  check('keccak256("") ', A.keccak256(''), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470')
  return out
}
