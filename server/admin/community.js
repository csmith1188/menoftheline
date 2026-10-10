import {
  closeDevRound,
  fulfillFundingGoal,
  getCommunityAdminBundle,
  saveDevSlots,
  saveFundingSlots,
} from "../db.js";

export async function communityAdminIndexData() {
  return getCommunityAdminBundle();
}

export {
  closeDevRound,
  fulfillFundingGoal,
  saveDevSlots,
  saveFundingSlots,
};
