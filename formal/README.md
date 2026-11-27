# PhIP formal models (non-normative)

Lean 4 models of the small, pure-logic parts of the spec, with machine-checked
proofs of their key properties. **The spec text is normative.** If a model
and `spec/phip-core.md` disagree, the model is wrong. Fix it in the same PR
that changes the spec.

No Mathlib. Most proofs enumerate the finite state space with `decide`.

## What is modelled

| File | Spec | Properties proved |
|---|---|---|
| `PhIPFormal/Lifecycle.lean` | §9, §6.2 | Terminal states have no successors. Every state can reach a terminal state, for `design` objects too. A concept, design or prototype can reach `disposed` without passing `qualified` (abandon path). `qualified` never returns to concept, design or prototype (design freeze). `design` objects never reach `deployed`, but can still be decommissioned. Accepted transitions stay in the object type's track. |
| `PhIPFormal/Capability.lean` | §11.3, §11.5.2 | Narrow push scopes are within `push_events`. Read scopes never authorize writes. `read_topology` authorizes only topology-mode GET history and is a proper subset of `read_history`. An accepted `granted_to: "*"` token authorizes only GET state or topology GET, never a write. An actor-bound token is accepted only from that actor. |
| `PhIPFormal/Reach.lean` | — | Finite reachability helper used by the lifecycle proofs. |

## Not modelled

Hash-chain integrity, JCS, and signatures (the test vectors in `tests/vectors`
cover these by example), `object_filter` glob matching, federation, and
authority transfer. Distributed-protocol properties such as concurrent PUSH
and authority transfer suit a model checker (TLA+ or Alloy) better than Lean.

## Build

Install [elan](https://github.com/leanprover/elan), then:

```
cd formal
lake build
```

A successful build means every theorem is proved. CI runs the same build.
