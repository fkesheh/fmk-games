# SKI SPLAT v3 — ROUND-0 visual baseline

Captured against HEAD, fixed seed 42, viewport 1280x720, shadows + full post stack ON.

| filename | shot description | dimensions | file size | capture wall-time | sim @ capture (z, v, airborne) | status |
|---|---|---|---|---|---|---|
| v3-wide-vista.png | wide vista — z 60-90, v>15, steer held 0 | 1280x720 | 791KB | 1.8s | z=65.7, v=15.3, airborne=false | ok |
| v3-descent.png | mid-descent at speed — z 250-300, v>20 | 1280x720 | 920KB | 1.7s | z=250.8, v=25.4, airborne=false | ok |
| v3-veg-margin.png | vegetation margin — z 150-200, plants near the corridor | 1280x720 | 881KB | 2s | z=154.1, v=17.7, airborne=false | ok |
| v3-forest-wall.png | corridor bend — z 330-380, |x| local max | 1280x720 | 871KB | 1.7s | z=346.8, v=7.7, airborne=false | ok |
| v3-atmosphere.png | atmosphere/distance haze — z 400-500 | 1280x720 | 876KB | 1.7s | z=405.2, v=16.4, airborne=false | ok |
| v3-air.png | airborne, near peak height | 1280x720 | 755KB | 1.6s | z=553.3, v=6.7, airborne=false | ok — no kicker launch achieved within budget; used manual setJump() timed to its computed ballistic apex (~112ms after launch) |
| v3-body-pov.png | first-person body/carve — |steer|=1, v>18 | 1280x720 | 714KB | 1.8s | z=712.3, v=10.2, airborne=false | ok — v never exceeded 18 within the 5000ms hold budget (last v=10.2) — the hold is kept short because CARVE_SCRUB bleeds speed fast under a sustained lock |
| v3-finish.png | near the finish line — z>760 | 1280x720 | 688KB | 1.5s | z=761.3, v=9.8, airborne=false | ok |
| v3-hud-ipad.png | iPad HUD + touch zones during racing | 2048x1536 | 2671KB | 3.1s | z=21.3, v=11.3, airborne=false | ok |
| v3-results.png | results screen | 1280x720 | 708KB | 1.2s | z=765.6, v=10.2, airborne=false | ok |
