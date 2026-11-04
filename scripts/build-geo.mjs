// Builds public/geo/{ga,fl}.json: one pre-projected SVG path per county.
// Run once: node scripts/build-geo.mjs <path to node_modules containing us-atlas, topojson-client, d3-geo>
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const modules = process.argv[2] || "node_modules";
const require = createRequire(path.resolve(modules, "x.js"));
const topojson = require("topojson-client");
const d3 = require("d3-geo");
const atlas = JSON.parse(readFileSync(path.resolve(modules, "us-atlas/counties-10m.json"), "utf8"));

const all = topojson.feature(atlas, atlas.objects.counties).features;
const STATES = { ga: "13", fl: "12", tx: "48" };
const WIDTH = 600;

mkdirSync("public/geo", { recursive: true });
for (const [key, fips] of Object.entries(STATES)) {
  const features = all.filter((f) => String(f.id).startsWith(fips));
  const fc = { type: "FeatureCollection", features };
  // Fit width, let height follow the state's shape.
  const projection = d3.geoMercator().fitWidth(WIDTH, fc);
  const bounds = d3.geoPath(projection).bounds(fc);
  const height = Math.ceil(bounds[1][1] - bounds[0][1]);
  projection.fitExtent([[2, 2], [WIDTH - 2, height - 2]], fc);
  const pathGen = d3.geoPath(projection).digits(1);
  const counties = features
    .map((f) => {
      const c = pathGen.centroid(f);
      return { fips: String(f.id), name: f.properties.name, d: pathGen(f), cx: Math.round(c[0]), cy: Math.round(c[1]) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  writeFileSync(`public/geo/${key}.json`, JSON.stringify({ width: WIDTH, height, counties }));
  console.log(key, counties.length, "counties", height, "px tall");
}
