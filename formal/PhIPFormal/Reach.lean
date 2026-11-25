/-!
# Finite reachability

A small, executable reachability check over a finite state list, so that
lifecycle properties can be discharged by `decide`.

`closure all step n S` saturates `S` under `step` for `n` rounds. With
`n = all.length` the result is a fixpoint (each round either adds a state
or changes nothing). The lifecycle files check the fixpoint property
explicitly with `decide` rather than proving it in general.
-/

namespace PhIP

/-- One round: everything already in `S`, plus every direct successor. -/
def step1 {α} [BEq α] (all : List α) (step : α → α → Bool) (S : List α) : List α :=
  all.filter fun t => S.contains t || S.any fun s => step s t

def closure {α} [BEq α] (all : List α) (step : α → α → Bool) : Nat → List α → List α
  | 0, S => S
  | n + 1, S => closure all step n (step1 all step S)

/-- `b` is reachable from `a` in zero or more steps. -/
def reachable {α} [BEq α] (all : List α) (step : α → α → Bool) (a b : α) : Bool :=
  (closure all step all.length [a]).contains b

/-- The closure from `a` is saturated (one more round changes nothing). -/
def saturated {α} [BEq α] (all : List α) (step : α → α → Bool) (a : α) : Bool :=
  let c := closure all step all.length [a]
  step1 all step c == c

end PhIP
