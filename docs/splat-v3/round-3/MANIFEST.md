# SKI SPLAT v3 — ROUND-0 visual baseline

Captured against HEAD, fixed seed 42, viewport 1280x720, shadows + full post stack ON.

| filename | shot description | dimensions | file size | capture wall-time | sim @ capture (z, v, airborne) | status |
|---|---|---|---|---|---|---|
| v3-wide-vista.png | wide vista — z 60-90, v>15, steer held 0 | 1280x720 | 891KB | 1.6s | z=62.7, v=15.3, airborne=false | ok |
| v3-descent.png | mid-descent at speed — z 250-300, v>20 | 1280x720 | 797KB | 1.5s | z=250.8, v=25.4, airborne=false | ok |
| v3-veg-margin.png | vegetation margin — z 150-200, plants near the corridor | 1280x720 | 876KB | 1.5s | z=150.6, v=17.5, airborne=false | ok |
| v3-forest-wall.png | corridor bend — z 330-380, |x| local max | 1280x720 | 827KB | 1.4s | z=350.4, v=7.8, airborne=false | ok |
| v3-atmosphere.png | atmosphere/distance haze — z 400-500 | 1280x720 | 902KB | 1.4s | z=406.3, v=15.7, airborne=false | ok |
| v3-air.png | airborne, near peak height | 1280x720 | 861KB | 1.3s | z=570.3, v=7.7, airborne=true | ok — no kicker launch achieved within budget; used manual setJump() timed to its computed ballistic apex (~112ms after launch) |
| v3-body-pov.png | first-person body/carve — |steer|=1, v>18 | 1280x720 | 809KB | 1.3s | z=664.9, v=18.4, airborne=false | ok |
| v3-finish.png | near the finish line — z>760 | 1280x720 | 833KB | 1.9s | z=762.6, v=14.8, airborne=false | ok |
| v3-hud-ipad.png | iPad HUD + touch zones during racing | 2048x1536 | 2330KB | 3.8s | z=18, v=8.7, airborne=false | ok |
| v3-results.png | results screen | 1280x720 | 709KB | 1.2s | z=800.4, v=16.5, airborne=false | ok |
