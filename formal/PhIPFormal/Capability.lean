/-!
# Capability tokens (spec §11.3, §11.5.2)

A model of token scopes, the operation→scope mapping, and the resolver's
verification steps. Signature checking, the validity window, and
`object_filter` glob matching are abstracted as inputs: this file checks
how the steps combine, not cryptography or string matching.
-/

namespace PhIP.Capability

/-- Core event types (`coreEventType` in `schemas/topology-response.json`). -/
inductive EventType
  | created | stateTransition | attributeUpdate | relationAdded | relationRemoved
  | softwareUpdate | measurement | process | lotSplit | lotMerge | note
  | authorityTransfer
  deriving DecidableEq, Repr

/-- §11.3.2 scope vocabulary. -/
inductive Scope
  | pushEvents | pushState | pushMeasurements | pushRelations
  | readState | readHistory | readTopology | readQuery
  deriving DecidableEq, Repr

/-- Requests a token can authorize. -/
inductive Op
  | push (e : EventType)
  | getState
  | getHistory         -- default GET history (full payloads)
  | getTopology        -- GET history with `?disclosure=topology`
  | query
  deriving DecidableEq, Repr

/-- §11.3.2 + the §11.5.2 step-5 operation table. -/
def Scope.permits : Scope → Op → Bool
  | .pushEvents,       .push _                => true
  | .pushState,        .push .stateTransition => true
  | .pushMeasurements, .push .measurement     => true
  | .pushRelations,    .push .relationAdded   => true
  | .pushRelations,    .push .relationRemoved => true
  | .readState,        .getState              => true
  | .readHistory,      .getState              => true
  | .readHistory,      .getHistory            => true
  | .readHistory,      .getTopology           => true
  | .readTopology,     .getTopology           => true
  | .readQuery,        .query                 => true
  | _,                 _                      => false

def Scope.isPush : Scope → Bool
  | .pushEvents | .pushState | .pushMeasurements | .pushRelations => true
  | _ => false

def Op.isWrite : Op → Bool
  | .push _ => true
  | _ => false

/-- §11.3.4 step 3: the only scopes honored with `granted_to: "*"`. -/
def anonAllowed : Scope → Bool
  | .readTopology | .readState => true
  | _ => false

inductive Grantee
  | anyone                 -- `granted_to: "*"`
  | actor (id : String)

structure Token where
  grantee : Grantee
  scope : Scope
  /-- Step 2 result: signature valid and `key_id` bound to `granted_by`. -/
  sigValid : Bool
  /-- Step 4 result: `now` within `not_before` / `expires`. -/
  inWindow : Bool
  /-- `object_filter` as a predicate on target `phip_id`s. -/
  filter : String → Bool

def anonOk (tok : Token) : Bool :=
  match tok.grantee with
  | .anyone => anonAllowed tok.scope
  | .actor _ => true

def actorMatches (tok : Token) (presenter : String) : Bool :=
  match tok.grantee with
  | .anyone => true
  | .actor id => id == presenter

/-- §11.3.4 steps 2–7, in order. -/
def verify (tok : Token) (presenter target : String) (op : Op) : Bool :=
  tok.sigValid && (anonOk tok && (tok.inWindow &&
    (actorMatches tok presenter && (tok.filter target && tok.scope.permits op))))

/-! ## Scope lattice -/

/-- `push_events` subsumes every narrower push scope. -/
theorem push_scopes_within_pushEvents (s : Scope) (o : Op) :
    s.isPush = true → s.permits o = true → Scope.pushEvents.permits o = true := by
  cases s <;> cases o <;> (try (rename_i e; cases e)) <;> decide

/-- Read scopes never authorize a write; push scopes never authorize a read. -/
theorem scopes_split_by_direction (s : Scope) (o : Op) :
    s.permits o = true → s.isPush = o.isWrite := by
  cases s <;> cases o <;> (try (rename_i e; cases e)) <;> decide

/-- §11.3.2: a `read_topology` token satisfies only topology-mode GET history. -/
theorem readTopology_only_topology (o : Op) :
    Scope.readTopology.permits o = true → o = .getTopology := by
  cases o <;> (try (rename_i e; cases e)) <;> decide

/-- §11.3.2: topology is a proper subset of what `read_history` grants. -/
theorem readTopology_proper_subset_of_readHistory :
    (∀ o, Scope.readTopology.permits o = true → Scope.readHistory.permits o = true) ∧
    Scope.readHistory.permits .getHistory = true ∧
    Scope.readTopology.permits .getHistory = false := by
  refine ⟨?_, by decide, by decide⟩
  intro o
  cases o <;> (try (rename_i e; cases e)) <;> decide

/-! ## Anonymous tokens (§11.3.1, §11.3.4 step 3) -/

theorem anon_scope_ops (s : Scope) (o : Op) :
    anonAllowed s = true → s.permits o = true → o = .getState ∨ o = .getTopology := by
  cases s <;> cases o <;> (try (rename_i e; cases e)) <;> decide

/-- Any accepted `granted_to: "*"` token authorizes only GET state or
topology-mode GET history: never a push, full history, or QUERY,
whatever the issuer signed. -/
theorem anonymous_tokens_are_low_leakage (tok : Token) (presenter target : String)
    (op : Op) (h : verify tok presenter target op = true)
    (hanon : tok.grantee = .anyone) :
    op = .getState ∨ op = .getTopology := by
  simp only [verify, Bool.and_eq_true] at h
  obtain ⟨_, hok, _, _, _, hperm⟩ := h
  have hallowed : anonAllowed tok.scope = true := by
    simpa [anonOk, hanon] using hok
  exact anon_scope_ops tok.scope op hallowed hperm

/-- Corollary: no accepted anonymous token ever authorizes a write. -/
theorem anonymous_tokens_never_write (tok : Token) (presenter target : String)
    (op : Op) (h : verify tok presenter target op = true)
    (hanon : tok.grantee = .anyone) :
    op.isWrite = false := by
  rcases anonymous_tokens_are_low_leakage tok presenter target op h hanon with rfl | rfl <;> rfl

/-! ## Actor binding (§11.3.4 step 5) -/

/-- A token bound to an actor is accepted only from that actor. -/
theorem bound_token_requires_grantee (tok : Token) (id presenter target : String)
    (op : Op) (h : verify tok presenter target op = true)
    (hbound : tok.grantee = .actor id) :
    id = presenter := by
  simp only [verify, Bool.and_eq_true] at h
  obtain ⟨_, _, _, hact, _, _⟩ := h
  simpa [actorMatches, hbound] using hact

end PhIP.Capability
