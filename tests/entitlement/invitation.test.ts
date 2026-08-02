import { describe, expect, it } from "vitest";

import {
  hashInvitationCode,
  invitationCodeHint,
  normalizeInvitationCode,
} from "@/modules/entitlement/invitation";

describe("invitation codes", () => {
  it("normalizes codes before hashing", () => {
    expect(normalizeInvitationCode(" muzhi-demo ")).toBe("MUZHI-DEMO");
    expect(hashInvitationCode("muzhi-demo", "secret")).toBe(
      hashInvitationCode(" MUZHI-DEMO ", "secret"),
    );
  });

  it("only exposes a short hint", () => {
    expect(invitationCodeHint("MUZHI-ABCDEFGHIJKL")).toBe(
      "MUZHI-AB…IJKL",
    );
  });
});
