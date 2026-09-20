#!/usr/bin/env node
/**
 * Generates samples/sample-building.ifc — a small deterministic IFC4 building
 * (2 storeys, 2 walls, 1 slab, 1 door) with fully independent entity chains,
 * used by the test-suite and the demo flow.
 *
 * Run: node scripts/generate-sample-ifc.js
 */
const fs = require("node:fs");
const path = require("node:path");

const lines = [];
let id = 0;
const add = (body) => {
  lines.push(`#${++id}=${body};`);
  return id;
};

// --- fixed header entities: #1 project, #2 owner history, ... #13 world point
add(`IFCPROJECT('0YvctVUKr0kugbFTf53O9L',#2,'Sample Project',$,$,$,$,(#11),#7)`);
const owner = 2;
add(`IFCOWNERHISTORY(#3,#6,$,.ADDED.,$,$,$,1759400000)`);
add(`IFCPERSONANDORGANIZATION(#4,#5,$)`);
add(`IFCPERSON($,'Demo','User',$,$,$,$,$)`);
add(`IFCORGANIZATION($,'OpenBIM Hub Demo',$,$,$)`);
add(`IFCAPPLICATION(#5,'0.1.0','OpenBIM Hub','OBH')`);
add(`IFCUNITASSIGNMENT((#8,#9,#10))`);
add(`IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)`);
add(`IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)`);
add(`IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)`);
const CONTEXT = add(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#12,$)`); // #11
add(`IFCAXIS2PLACEMENT3D(#13,$,$)`); // #12
add(`IFCCARTESIANPOINT((0.,0.,0.))`); // #13

/** Axis placement at a point (independent entity chain). */
const point3 = (x, y, z) => {
  const p = add(`IFCCARTESIANPOINT((${x},${y},${z}))`);
  return add(`IFCAXIS2PLACEMENT3D(#${p},$,$)`);
};
const point2 = (x, y) => {
  const p = add(`IFCCARTESIANPOINT((${x},${y}))`);
  return add(`IFCAXIS2PLACEMENT2D(#${p},$)`);
};

const sitePlacement = point3(0, 0, 0);
const site = add(
  `IFCSITE('1sQPDPPXvATBmG_rT2sJiC',#${owner},'Demo Site',$,$,#${sitePlacement},$,$,.ELEMENT.,$,$,0.,$,$)`
);

const buildingPlacement = add(`IFCLOCALPLACEMENT(#${sitePlacement},#${point3(0, 0, 0)})`);
const building = add(
  `IFCBUILDING('2rSmgPPXvATBmG_rT2sJiC',#${owner},'Demo Building',$,$,#${buildingPlacement},$,$,.ELEMENT.,$,$,$)`
);

const storey1Placement = add(`IFCLOCALPLACEMENT(#${buildingPlacement},#${point3(0, 0, 0)})`);
const storey1 = add(
  `IFCBUILDINGSTOREY('3rSmgPPXvATBmG_rT2sJiC',#${owner},'Ground Floor',$,$,#${storey1Placement},$,$,.ELEMENT.,0.)`
);
const storey2Placement = add(`IFCLOCALPLACEMENT(#${buildingPlacement},#${point3(0, 0, 3500.)})`);
const storey2 = add(
  `IFCBUILDINGSTOREY('0rSmgPPXvATBmG_rT2sJiC',#${owner},'First Floor',$,$,#${storey2Placement},$,$,.ELEMENT.,3500.)`
);

/**
 * Emits a box-shaped product: profile xdim×ydim (XY), extruded `depth` along +Z
 * (local frame), placed at (px,py,pz) within its storey, with its own surface style.
 */
function boxProduct(guid, type, name, storeyPlacement, px, py, pz, xdim, ydim, depth, colour, transparency) {
  const placement = add(`IFCLOCALPLACEMENT(#${storeyPlacement},#${point3(px, py, pz)})`);
  const profilePos = point2(0, 0);
  const profile = add(`IFCRECTANGLEPROFILEDEF(.AREA.,$,#${profilePos},${xdim},${ydim})`);
  const extrudePos = point3(0, 0, 0);
  const dir = add(`IFCDIRECTION((0.,0.,1.))`);
  const extrude = add(`IFCEXTRUDEDAREASOLID(#${profile},#${extrudePos},#${dir},${depth})`);
  const rep = add(`IFCSHAPEREPRESENTATION(#${CONTEXT},'Body','SweptSolid',(#${extrude}))`);
  const shape = add(`IFCPRODUCTDEFINITIONSHAPE($,$,(#${rep}))`);
  const expressID = add(
    `${type}('${guid}',#${owner},'${name}',$,'',#${placement},#${shape},$,$)`
  );
  const colourId = add(`IFCCOLOURRGB($,${colour[0]},${colour[1]},${colour[2]})`);
  const styleRender = add(
    `IFCSURFACESTYLERENDERING(#${colourId},${transparency === null ? "$" : transparency},$,$,$,$,$,$,.NOTDEFINED.)`
  );
  const style = add(`IFCSURFACESTYLE('${name} style',.BOTH.,(#${styleRender}))`);
  add(`IFCSTYLEDITEM(#${extrude},(#${style}),$)`);
  return expressID;
}

const wall1 = boxProduct("1r6PQPPXvATBmG_rT2sJiC", "IFCWALL", "Wall Ground", storey1Placement, "0.", "0.", "0.", "5000.", "200.", "3000.", [0.78, 0.78, 0.77], null);
const slab = boxProduct("2r6PQPPXvATBmG_rT2sJiC", "IFCSLAB", "Ground Slab", storey1Placement, "0.", "0.", "-200.", "8000.", "6000.", "200.", [0.55, 0.55, 0.55], null);
const wall2 = boxProduct("3r6PQPPXvATBmG_rT2sJiC", "IFCWALL", "Wall First", storey2Placement, "500.", "0.", "0.", "4000.", "200.", "3000.", [0.45, 0.65, 0.85], "0.5");
const door = boxProduct("0r6PQPPXvATBmG_rT2sJiC", "IFCDOOR", "Door First", storey2Placement, "1500.", "0.", "0.", "900.", "100.", "2100.", [0.55, 0.36, 0.20], null);

add(`IFCRELAGGREGATES('1YAPQPPXvATBmG_rT2sJiC',#${owner},$,$,#1,(#${site}))`);
add(`IFCRELAGGREGATES('2YAPQPPXvATBmG_rT2sJiC',#${owner},$,$,#${site},(#${building}))`);
add(`IFCRELAGGREGATES('3YAPQPPXvATBmG_rT2sJiC',#${owner},$,$,#${building},(#${storey1},#${storey2}))`);
add(`IFCRELCONTAINEDINSPATIALSTRUCTURE('0aPQPPXvATBmG_rT2sJiC',#${owner},$,$,(#${wall1},#${slab}),#${storey1})`);
add(`IFCRELCONTAINEDINSPATIALSTRUCTURE('1aPQPPXvATBmG_rT2sJiC',#${owner},$,$,(#${wall2},#${door}),#${storey2})`);

// property set on the ground wall
const p1 = add(`IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.T.),$)`);
const p2 = add(`IFCPROPERTYSINGLEVALUE('LoadBearing',$,IFCBOOLEAN(.T.),$)`);
const p3 = add(`IFCPROPERTYSINGLEVALUE('ThermalTransmittance',$,IFCTHERMALTRANSMITTANCEMEASURE(1.8),$)`);
const pset = add(`IFCPROPERTYSET('2aPQPPXvATBmG_rT2sJiC',#${owner},'Pset_WallCommon',$,(#${p1},#${p2},#${p3}))`);
add(`IFCRELDEFINESBYPROPERTIES('3aPQPPXvATBmG_rT2sJiC',#${owner},$,$,(#${wall1}),#${pset})`);

const ifc = ["ISO-10303-21;", "HEADER;", "FILE_DESCRIPTION(('OpenBIM Hub sample building'),'2;1');", `FILE_NAME('sample-building.ifc','2026-09-03T00:00:00',('OpenBIM Hub'),('OpenBIM Hub'),'','','');`, "FILE_SCHEMA(('IFC4'));", "ENDSEC;", "DATA;", ...lines, "ENDSEC;", "END-ISO-10303-21;", ""].join("\n");

const out = path.join(__dirname, "..", "samples", "sample-building.ifc");
fs.writeFileSync(out, ifc);
console.log(`wrote ${out} (${ifc.length} bytes, ${lines.length} entities)`);
