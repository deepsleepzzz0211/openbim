#!/usr/bin/env node
/**
 * Generates a large synthetic IFC4 model for conversion-scaling benchmarks:
 * N identical walls in one storey sharing one colour, i.e. a single geometry
 * bucket whose float32 accumulation dominates buffer-mode memory.
 *
 * Run: node scripts/generate-stress-ifc.js [walls=50000] [out=bench-stress.ifc]
 */
const fs = require("node:fs");

const walls = Number(process.argv[2] || 50000);
const out = process.argv[3] || "bench-stress.ifc";

const lines = [];
let id = 0;
const add = (body) => {
  lines.push(`#${++id}=${body};`);
  return id;
};

add(`IFCPROJECT('0YvctVUKr0kugbFTf53O9L',#2,'Stress Project',$,$,$,$,(#11),#7)`);
const owner = 2;
add(`IFCOWNERHISTORY(#3,#6,$,.ADDED.,$,$,$,1759400000)`);
add(`IFCPERSONANDORGANIZATION(#4,#5,$)`);
add(`IFCPERSON($,'Bench','User',$,$,$,$,$)`);
add(`IFCORGANIZATION($,'OpenBIM Hub Bench',$,$,$)`);
add(`IFCAPPLICATION(#5,'0.1.0','OpenBIM Hub','OBH')`);
add(`IFCUNITASSIGNMENT((#8,#9,#10))`);
add(`IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)`);
add(`IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)`);
add(`IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)`);
const CONTEXT = add(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#12,$)`);
add(`IFCAXIS2PLACEMENT3D(#13,$,$)`);
add(`IFCCARTESIANPOINT((0.,0.,0.))`);

const point3 = (x, y, z) => {
  const p = add(`IFCCARTESIANPOINT((${x},${y},${z}))`);
  return add(`IFCAXIS2PLACEMENT3D(#${p},$,$)`);
};
const point2 = (x, y) => {
  const p = add(`IFCCARTESIANPOINT((${x},${y}))`);
  return add(`IFCAXIS2PLACEMENT2D(#${p},$)`);
};

const sitePlacement = point3(0, 0, 0);
const site = add(`IFCSITE('1sQPDPPXvATBmG_rT2sJiC',#${owner},'Stress Site',$,$,#${sitePlacement},$,$,.ELEMENT.,$,$,0.,$,$)`);
const buildingPlacement = add(`IFCLOCALPLACEMENT(#${sitePlacement},#${point3(0, 0, 0)})`);
const building = add(`IFCBUILDING('2rSmgPPXvATBmG_rT2sJiC',#${owner},'Stress Building',$,$,#${buildingPlacement},$,$,.ELEMENT.,$,$,$)`);
const storeyPlacement = add(`IFCLOCALPLACEMENT(#${buildingPlacement},#${point3(0, 0, 0)})`);
const storey = add(`IFCBUILDINGSTOREY('3rSmgPPXvATBmG_rT2sJiC',#${owner},'Ground Floor',$,$,#${storeyPlacement},$,$,.ELEMENT.,0.)`);

const dir = add(`IFCDIRECTION((0.,0.,1.))`);
const colourId = add(`IFCCOLOURRGB($,0.78,0.78,0.77)`);
const styleRender = add(`IFCSURFACESTYLERENDERING(#${colourId},$,$,$,$,$,$,$,.NOTDEFINED.)`);
const style = add(`IFCSURFACESTYLE('Wall style',.BOTH.,(#${styleRender}))`);

const guid = (i) => `W${String(i).padStart(8, "0")}Stress0000000`; // 22 chars, STEP-safe alphabet

const wallIds = [];
const GRID = Math.ceil(Math.sqrt(walls));
for (let i = 0; i < walls; i++) {
  const gx = (i % GRID) * 5000;
  const gy = Math.floor(i / GRID) * 5000;
  const placement = add(`IFCLOCALPLACEMENT(#${storeyPlacement},#${point3(gx, gy, 0)})`);
  const profilePos = point2(0, 0);
  const profile = add(`IFCRECTANGLEPROFILEDEF(.AREA.,$,#${profilePos},4000.,200.)`);
  const extrudePos = point3(0, 0, 0);
  const extrude = add(`IFCEXTRUDEDAREASOLID(#${profile},#${extrudePos},#${dir},3000.)`);
  const rep = add(`IFCSHAPEREPRESENTATION(#${CONTEXT},'Body','SweptSolid',(#${extrude}))`);
  const shape = add(`IFCPRODUCTDEFINITIONSHAPE($,$,(#${rep}))`);
  const expressID = add(
    `IFCWALL('${guid(i)}',#${owner},'Wall ${i}',$,'',#${placement},#${shape},$,$)`
  );
  add(`IFCSTYLEDITEM(#${extrude},(#${style}),$)`);
  wallIds.push(expressID);
}

add(`IFCRELAGGREGATES('1YAPQPPXvATBmG_rT2sJiC',#${owner},$,$,#1,(#${site}))`);
add(`IFCRELAGGREGATES('2YAPQPPXvATBmG_rT2sJiC',#${owner},$,$,#${site},(#${building}))`);
add(`IFCRELAGGREGATES('3YAPQPPXvATBmG_rT2sJiC',#${owner},$,$,#${building},(#${storey}))`);
for (let i = 0; i < wallIds.length; i += 500) {
  const chunk = wallIds.slice(i, i + 500);
  add(
    `IFCRELCONTAINEDINSPATIALSTRUCTURE('C${String(i / 500).padStart(18, "0")}',#${owner},$,$,(${chunk.map((w) => `#${w}`).join(",")}),#${storey})`
  );
}

const header = [
  "ISO-10303-21;",
  "HEADER;",
  "FILE_DESCRIPTION(('OpenBIM Hub stress model'),'2;1');",
  `FILE_NAME('${out}','2026-09-20T00:00:00',('OpenBIM Hub'),('OpenBIM Hub'),'','','');`,
  "FILE_SCHEMA(('IFC4'));",
  "ENDSEC;",
  "DATA;",
];
const text = [...header, ...lines, "ENDSEC;", "END-ISO-10303-21;", ""].join("\n");
fs.writeFileSync(out, text);
console.log(`wrote ${out} (${(text.length / 1e6).toFixed(1)} MB, ${walls} walls, ${lines.length} entities)`);
