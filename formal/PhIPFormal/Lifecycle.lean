import PhIPFormal.Reach

/-!
# Lifecycle state machine (spec §9, §6.2)

A model of the two lifecycle tracks, the per-type narrowing for `design`
objects, and track enforcement. Each theorem names the spec rule it checks.

Not modelled: event signing, the history fold (§9.5), and the
`note`-after-`archived` exception (§9.3.1), which is not a state
transition.
-/

namespace PhIP.Lifecycle

/-! ## Manufacturing track (§9.2) -/

inductive MState where
  | concept | design | prototype | qualified | stock
  | deployed | maintained | decommissioned | consumed | disposed
  deriving DecidableEq, Repr

def MState.all : List MState :=
  [.concept, .design, .prototype, .qualified, .stock,
   .deployed, .maintained, .decommissioned, .consumed, .disposed]

/-- §9.2.1 transition table, verbatim. -/
def MState.next : MState → List MState
  | .concept        => [.design, .disposed]
  | .design         => [.prototype, .qualified, .disposed]
  | .prototype      => [.design, .qualified, .disposed]
  | .qualified      => [.stock, .consumed]
  | .stock          => [.deployed, .decommissioned, .consumed]
  | .deployed       => [.maintained, .decommissioned]
  | .maintained     => [.deployed, .decommissioned]
  | .decommissioned => [.consumed, .disposed]
  | .consumed       => []
  | .disposed       => []

def MState.terminal : MState → Bool
  | .consumed | .disposed => true
  | _ => false

/-- One manufacturing-track step. `isDesign` applies the §6.2 narrowing:
a `design` object never enters `deployed` or `maintained`. -/
def mStep (isDesign : Bool) (a b : MState) : Bool :=
  a.next.contains b && !(isDesign && (b == .deployed || b == .maintained))

/-! ## Operational track (§9.3) -/

inductive OState where
  | planned | active | inactive | archived
  deriving DecidableEq, Repr

def OState.all : List OState := [.planned, .active, .inactive, .archived]

/-- §9.3.1 transition table, verbatim. -/
def OState.next : OState → List OState
  | .planned  => [.active, .archived]
  | .active   => [.inactive, .archived]
  | .inactive => [.active, .archived]
  | .archived => []

def OState.terminal : OState → Bool
  | .archived => true
  | _ => false

def oStep (a b : OState) : Bool := a.next.contains b

/-! ## Sanity: the fuel used by `reachable` is enough -/

theorem m_closure_saturated (d : Bool) (s : MState) :
    saturated MState.all (mStep d) s = true := by
  cases d <;> cases s <;> decide

theorem o_closure_saturated (s : OState) :
    saturated OState.all oStep s = true := by
  cases s <;> decide

/-! ## Terminal states (§9.2.1, §9.3.1) -/

/-- `consumed` and `disposed` accept no further transitions. -/
theorem m_terminal_no_successors (s : MState) :
    s.terminal = true → s.next = [] := by
  cases s <;> decide

theorem o_terminal_no_successors (s : OState) :
    s.terminal = true → s.next = [] := by
  cases s <;> decide

/-! ## No dead ends

Every state can still reach a terminal state, for ordinary types and for
`design` objects under the §6.2 narrowing. This would hold even without
the §9.2.1 abandon edges (via `qualified → consumed`), so the abandon
property is checked separately below. -/

def mCanTerminate (d : Bool) (s : MState) : Bool :=
  MState.all.any fun t => t.terminal && reachable MState.all (mStep d) s t

theorem m_no_dead_ends (d : Bool) (s : MState) : mCanTerminate d s = true := by
  cases d <;> cases s <;> decide

theorem o_no_dead_ends (s : OState) :
    (OState.all.any fun t => t.terminal && reachable OState.all oStep s t) = true := by
  cases s <;> decide

/-! ## Abandon path (§9.2.1)

A concept, design or prototype can be retired without a false
`qualified` record: `disposed` is reachable when `qualified` is removed
from the graph. -/

def mStepAvoidingQualified (d : Bool) (a b : MState) : Bool :=
  mStep d a b && a != .qualified && b != .qualified

theorem abandon_without_qualification (d : Bool) :
    reachable MState.all (mStepAvoidingQualified d) .concept .disposed = true ∧
    reachable MState.all (mStepAvoidingQualified d) .design .disposed = true ∧
    reachable MState.all (mStepAvoidingQualified d) .prototype .disposed = true := by
  cases d <;> decide

/-! ## Design freeze (§9.2: "`qualified` — Design is frozen")

Once qualified, an object can never return to concept, design or
prototype. -/

theorem qualified_is_frozen (d : Bool) :
    reachable MState.all (mStep d) .qualified .concept = false ∧
    reachable MState.all (mStep d) .qualified .design = false ∧
    reachable MState.all (mStep d) .qualified .prototype = false := by
  cases d <;> decide

/-! ## Design narrowing (§6.2) -/

/-- A `design` object never reaches `deployed` or `maintained`… -/
theorem design_never_in_service (s : MState) :
    (reachable MState.all (mStep true) s .deployed = false ∨ s = .deployed) ∧
    (reachable MState.all (mStep true) s .maintained = false ∨ s = .maintained) := by
  cases s <;> decide

/-- …a released design can still be retired (`stock → decommissioned`)… -/
theorem design_release_retires :
    reachable MState.all (mStep true) .stock .decommissioned = true := by
  decide

/-- …and the narrowing really narrows: other types do reach `deployed`. -/
theorem narrowing_not_vacuous :
    reachable MState.all (mStep false) .concept .deployed = true := by
  decide

/-! ## Track enforcement (§9.1) -/

inductive Track | manufacturing | operational
  deriving DecidableEq, Repr

inductive ObjType
  | material | component | assembly | system | lot | design
  | actor | location | vehicle
  deriving DecidableEq, Repr

def ObjType.track : ObjType → Track
  | .material | .component | .assembly | .system | .lot | .design => .manufacturing
  | .actor | .location | .vehicle => .operational

def ObjType.isDesign : ObjType → Bool
  | .design => true
  | _ => false

inductive State
  | m (s : MState)
  | o (s : OState)
  deriving DecidableEq, Repr

def State.track : State → Track
  | .m _ => .manufacturing
  | .o _ => .operational

/-- A resolver accepts a `state_transition` only within the object's own track. -/
def validTransition (t : ObjType) : State → State → Bool
  | .m a, .m b =>
    match t.track with
    | .manufacturing => mStep t.isDesign a b
    | .operational => false
  | .o a, .o b =>
    match t.track with
    | .operational => oStep a b
    | .manufacturing => false
  | .m _, .o _ => false
  | .o _, .m _ => false

/-- No accepted transition leaves, enters, or crosses into the wrong track. -/
theorem track_separation (t : ObjType) (a b : State)
    (h : validTransition t a b = true) :
    a.track = t.track ∧ b.track = t.track := by
  cases t <;> cases a <;> cases b <;>
    simp_all [validTransition, ObjType.track, State.track]

end PhIP.Lifecycle
