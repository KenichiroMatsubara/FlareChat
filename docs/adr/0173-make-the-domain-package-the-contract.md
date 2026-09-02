# Make the domain package the contract

`packages/domain` is the contract between the Worker and the GUI: every response view a route returns is declared there once, the route handler returns a value of that type, and the GUI client imports the same type. The package had advertised this and nobody had used it — eleven of its thirteen data interfaces had no importer, the GUI client kept sixty-one local declarations that restated the same shapes under other names, and the Worker kept a third copy of `AutomationStatus` that had already lost a field the other two carried. A contract with no signatories is worse than none, because it looks like the check that is not happening.

The behaviour the package re-exports — retry policy, reminder arithmetic, attachment intake limits, the LINE signature — was always genuinely shared and stays. The dead data block is replaced by the views the routes actually return, named as CONTEXT.md names them, and the local copies in the GUI client and the Worker are deleted. A field added to a view then reaches the GUI at compile time, or fails to compile there, which is the whole point of a shared package.

## Consequences

The GUI client becomes a list of endpoints and paths over imported types. The Worker's route modules of ADR 0169 declare their return types explicitly, which is also what makes their shape reviewable.
