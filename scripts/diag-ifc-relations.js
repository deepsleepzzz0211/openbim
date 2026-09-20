/* 诊断：统计 IFC 文件中的空间关系与产品类型分布 */
const path = require("node:path");
const { createRequire } = require("node:module");
const requireFromIfc = createRequire(path.join(__dirname, "../packages/ifc/dist/index.js"));
const webifc = requireFromIfc("web-ifc");

const file = process.argv[2];
if (!file) {
  console.error("usage: node diag-ifc-relations.js <file.ifc>");
  process.exit(1);
}

const api = new webifc.IfcAPI();
api.SetWasmPath(requireFromIfc.resolve("web-ifc/web-ifc-node.wasm").replace(/web-ifc-node\.wasm$/, ""), true);

api.Init().then(() => {
  const data = require("node:fs").readFileSync(file);
  const modelID = api.OpenModel(new Uint8Array(data), { COORDINATE_TO_ORIGIN: true });

  // 1. 产品类型分布（统计所有 IFC 产品）
  const counts = new Map();
  const allTypes = [webifc.IFCWALL, webifc.IFCWALLSTANDARDCASE, webifc.IFCDOOR, webifc.IFCWINDOW,
    webifc.IFCFLOWSEGMENT, webifc.IFCFLOWFITTING, webifc.IFCFLOWTERMINAL, webifc.IFCFLOWCONTROLLER,
    webifc.IFCPIPESEGMENT, webifc.IFCPIPEFITTING, webifc.IFCFOOTING, webifc.IFCBEAM, webifc.IFCCOLUMN,
    webifc.IFCPLATE, webifc.IFCMEMBER, webifc.IFCCOVERING, webifc.IFCSLAB, webifc.IFCSTAIR, webifc.IFCSTAIRFLIGHT,
    webifc.IFCRAILING, webifc.IFCFURNISHINGELEMENT, webifc.IFCBUILDINGELEMENTPROXY, webifc.IFCSPACE,
    webifc.IFCDISTRIBUTIONELEMENT, webifc.IFCDISTRIBUTIONCONTROLELEMENT, webifc.IFCDISTRIBUTIONFLOWELEMENT,
    webifc.IFCREINFORCINGBAR, webifc.IFCPILE, webifc.IFCELEMENTASSEMBLY, webifc.IFCPROXY,
    webifc.IFCGEOGRAPHICELEMENT, webifc.IFCROADPART, webifc.IFCBRIDGEPART].filter((t) => t !== undefined && t > 0);
  for (const t of allTypes) {
    try {
      const ids = api.GetLineIDsWithType(modelID, t);
      if (ids.size() > 0) {
        const one = api.GetLine(modelID, ids.get(0), false);
        const name = (one?.constructor?.name || String(t)).replace(/^IFC/, "IFC");
        counts.set(name || String(t), ids.size());
      }
    } catch { /* type not in schema */ }
  }
  console.log("== 产品类型分布 ==");
  for (const [k, v] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ${v}\t${k}`);

  // 2. 空间关系统计
  for (const [label, type] of [["ContainedInSpatialStructure", webifc.IFCRELCONTAINEDINSPATIALSTRUCTURE],
    ["RelAggregates", webifc.IFCRELAGGREGATES], ["ReferencedInSpatialStructure", webifc.IFCRELREFERENCEDINSPATIALSTRUCTURE]]) {
    try {
      const ids = api.GetLineIDsWithType(modelID, type);
      let related = 0;
      for (let i = 0; i < ids.size(); i++) {
        const rel = api.GetLine(modelID, ids.get(i), true);
        related += (rel?.RelatedElements ?? rel?.RelatedObjects ?? []).length;
      }
      console.log(`== ${label}: ${ids.size()} 关系, ${related} 个关联对象`);
    } catch (e) { console.log(`== ${label}: error ${e.message}`); }
  }

  api.CloseModel(modelID);
  api.Dispose();
});
