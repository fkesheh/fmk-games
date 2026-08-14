# SKI SPLAT v3 — ROUND-0 visual baseline

Captured against HEAD, fixed seed 42, viewport 1280x720, shadows + full post stack ON.

| filename | shot description | dimensions | file size | capture wall-time | sim @ capture (z, v, airborne) | status |
|---|---|---|---|---|---|---|
| v3-wide-vista.png | wide vista — z 60-90, v>15, steer held 0 | 1280x720 | 517KB | 1.5s | z=63.7, v=15.4, airborne=false | ok |
| v3-descent.png | mid-descent at speed — z 250-300, v>20 | 1280x720 | 470KB | 1.4s | z=253.4, v=24.4, airborne=false | ok |
| v3-veg-margin.png | vegetation margin — z 150-200, plants near the corridor | 1280x720 | 510KB | 1.3s | z=152, v=19.5, airborne=false | ok |
| v3-forest-wall.png | corridor bend — z 330-380, |x| local max | 1280x720 | 128KB | 1.7s | z=352.1, v=8.2, airborne=false | ok |
| v3-atmosphere.png | atmosphere/distance haze — z 400-500 | 1280x720 | 398KB | 1.4s | z=402.7, v=13.1, airborne=false | ok |
| v3-air.png | airborne, near peak height | 1280x720 | 357KB | 0.9s | z=569.4, v=9.2, airborne=true | ok — no kicker launch achieved within budget; used manual setJump() timed to its computed ballistic apex (~112ms after launch) |
| v3-body-pov.png | first-person body/carve — |steer|=1, v>18 | 1280x720 | 351KB | 0.9s | z=679, v=18, airborne=false | ok |
| v3-finish.png | near the finish line — z>760 | 1280x720 | 368KB | 0.8s | z=765.3, v=16.2, airborne=false | ok |
| v3-hud-ipad.png | iPad HUD + touch zones during racing | 2048x1536 | 1795KB | 2.1s | z=13.5, v=7.4, airborne=false | ok |
| v3-results.png | results screen | 1280x720 | 417KB | 0.8s | z=800.2, v=18.6, airborne=false | ok |
