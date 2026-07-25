import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

export default buildModule("RelationshipRegistryModule", (m) => {
  const deployer = m.getAccount(0);
  const admin = m.getParameter("admin", deployer);
  const attester = m.getParameter("attester", deployer);
  const registry = m.contract("RelationshipRegistry", [admin, attester]);

  return { registry };
});
