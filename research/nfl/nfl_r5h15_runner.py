#!/usr/bin/env python3
from __future__ import annotations

import nfl_r5h15_independent_signal_family_discovery as h15
import nfl_r5h4_elite_selection_gate as r5h4

# Compatibility launcher for the R5H15 research script.
# R5H15 calls the frozen R5H4 reference helper through the module-global name `r5h4`.
# Inject it explicitly without altering any research logic or target-season custody.
h15.r5h4 = r5h4

if __name__ == "__main__":
    h15.main()
