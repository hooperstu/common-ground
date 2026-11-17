# Common Ground

Find the fairest place for a group of up to 30 people in the UK to meet by car.

Add people by postcode or address, set how much each person should travel, and the map shows the
fairest meeting point, a zone of almost-as-good spots around it, every person's route in its own
colour and a summary of each drive. Everything updates live as you move the sliders.

It is a single static page with no build step and no running costs, hosted on GitHub Pages.

## How it works

1. **Lookups.** Full postcodes and outcodes go to [postcodes.io](https://postcodes.io); anything
   else goes to OpenStreetMap's [Nominatim](https://nominatim.org) search, limited to the UK.
2. **Drive-time grid.** The app lays a grid of candidate spots over everyone's area and fetches the
   drive time from every person to every spot from the public [OSRM](https://project-osrm.org)
   server, in a handful of table requests. Spots far from any road (sea, moorland) are dropped.
3. **Fairness score (runs in the browser).** Each person's drive time is multiplied by their weight:
   sliding towards *travel less* makes their minutes count up to 4× as much; *travel more* down to ¼.
   Each spot's score is a blend of the *longest* weighted drive and the *average* weighted drive,
   set by the "What does fair mean?" slider. The lowest score wins. Because this uses cached drive
   times, moving any slider updates the result instantly with no network calls.
4. **Sharpening.** Once things settle, a finer grid is fetched around the winner.
5. **Fair zone.** Every spot scoring within about 4% (or 3 minutes) of the best is fitted with an
   ellipse, drawn as a circle or oval depending on how the good spots spread.
6. **Routes.** Real road routes to the meeting point are fetched in the background, cached, and drawn
   in each person's colour. Until a route arrives a dotted line is shown.

## Lift sharing

Each person can ride with someone else instead of driving. The driver chooses how they share:

- **Home pickup:** the driver collects passengers from their homes (nearest first), then drives on.
- **Meet point:** everyone in the car drives to a meet point the app picks (short for all of them and on the
  way to the likely venue), then they continue together.

Shared journeys count in full for everyone in the car, so the fairest venue accounts for detours and
pickups, and still updates live as the sliders move.

The list is saved in your browser, and **Share link** copies a URL containing the whole list.

## Run locally

Any static file server works, for example:

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000. Run the maths tests with `node tests/fairness.test.js`.

## Free services and fair use

The public OSRM, Nominatim and OpenStreetMap tile servers are free community services with usage
policies. The app spaces out its requests and caches results. If you expect heavy use, point
`config.js` at your own OSRM server.

Map data © OpenStreetMap contributors.
