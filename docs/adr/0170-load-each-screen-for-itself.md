# Load each screen for itself

Each screen of the administration GUI is one route with its own loader and its own actions, and the Account shell loads only what every screen shares: the application state and the Account. ADR 0167 made a Rule one screen; this makes a screen own its data as well as its layout.

The route layer had grown a different shape. `loadAccount` fired twenty requests on entry to any screen, whichever screen it was, and folded the results into a context of about ninety members; `AccountPage` read that context and re-emitted ninety-five props into `Dashboard`, whose `DashboardProps` interface mirrored them a second time and whose test fixture mirrored them a third. `AccountPage` had no implementation other than the pass-through, so its interface was strictly larger than its body — the definition of a shallow module — and deleting it removes complexity outright, because nothing it did has to be done anywhere else. The cost of the shape was measurable: the 903-line data layer had no tests, and the forty-four dashboard tests, rendering to static markup with forty stubs, could only assert first-paint HTML.

A screen module therefore exports a loader that requests the endpoints that screen reads and a component that renders that data and holds its own pending operations; the shell renders navigation, the error surface, and an outlet. `Dashboard` becomes that shell, `AccountPage` and `DashboardProps` are deleted, and the account context shrinks to the state, the Account, and the two actions every screen offers — sign out and reauthenticate. A screen is tested by rendering it against a fake client and driving its state, which needs a DOM in the test environment; that is a development dependency of the GUI and adds nothing to the Worker.

## Consequences

Entering a screen requests only that screen's data, so the Rules screen no longer waits for the delivery audit. Data one screen changes and another screen shows is re-read when the other screen is entered, which is the behaviour of a page rather than of a single shared cache, and it is the behaviour ADR 0150 already accepts for the automation itself.
