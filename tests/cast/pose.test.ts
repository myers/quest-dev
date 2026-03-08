import { describe, expect, it } from "vitest";
import {
  createPoseState,
  eulerToQuat,
  screenToYawPitch,
  setPoseAbsolute,
  updatePose,
} from "../../src/cast/pose.js";

describe("pose", () => {
  describe("createPoseState", () => {
    it("returns identity pose at origin", () => {
      const pose = createPoseState();
      expect(pose.x).toBe(0);
      expect(pose.y).toBe(0);
      expect(pose.z).toBe(0);
      expect(pose.qw).toBe(1);
      expect(pose.qx).toBe(0);
      expect(pose.qy).toBe(0);
      expect(pose.qz).toBe(0);
      expect(pose.yaw).toBe(0);
      expect(pose.pitch).toBe(0);
    });
  });

  describe("eulerToQuat", () => {
    it("returns identity quaternion for zero yaw/pitch", () => {
      const q = eulerToQuat(0, 0);
      expect(q.qw).toBeCloseTo(1);
      expect(q.qx).toBeCloseTo(0);
      expect(q.qy).toBeCloseTo(0);
      expect(q.qz).toBeCloseTo(0);
    });

    it("produces unit quaternion for 90-degree yaw", () => {
      const q = eulerToQuat(Math.PI / 2, 0);
      const mag = Math.sqrt(q.qw ** 2 + q.qx ** 2 + q.qy ** 2 + q.qz ** 2);
      expect(mag).toBeCloseTo(1);
    });

    it("produces unit quaternion for arbitrary angles", () => {
      const q = eulerToQuat(0.7, -0.3);
      const mag = Math.sqrt(q.qw ** 2 + q.qx ** 2 + q.qy ** 2 + q.qz ** 2);
      expect(mag).toBeCloseTo(1);
    });

    it("handles 180-degree yaw", () => {
      const q = eulerToQuat(Math.PI, 0);
      const mag = Math.sqrt(q.qw ** 2 + q.qx ** 2 + q.qy ** 2 + q.qz ** 2);
      expect(mag).toBeCloseTo(1);
    });
  });

  describe("updatePose", () => {
    it("applies yaw increment", () => {
      const pose = createPoseState();
      const updated = updatePose(pose, { dYaw: 0.5 });
      expect(updated.yaw).toBeCloseTo(0.5);
      // Position shouldn't change without forward/strafe
      expect(updated.x).toBeCloseTo(0);
      expect(updated.z).toBeCloseTo(0);
    });

    it("clamps pitch to ±π/2", () => {
      const pose = createPoseState();
      const up = updatePose(pose, { dPitch: 5.0 });
      expect(up.pitch).toBeCloseTo(Math.PI / 2);

      const down = updatePose(pose, { dPitch: -5.0 });
      expect(down.pitch).toBeCloseTo(-Math.PI / 2);
    });

    it("moves forward in facing direction", () => {
      const pose = createPoseState(); // facing +Z (yaw=0)
      const moved = updatePose(pose, { dForward: 1.0 });
      expect(moved.z).toBeCloseTo(1.0);
      expect(moved.x).toBeCloseTo(0);
    });

    it("moves forward in rotated direction", () => {
      let pose = createPoseState();
      pose = updatePose(pose, { dYaw: Math.PI / 2 }); // face +X
      const moved = updatePose(pose, { dForward: 1.0 });
      expect(moved.x).toBeCloseTo(1.0);
      expect(moved.z).toBeCloseTo(0, 5);
    });

    it("strafes perpendicular to facing", () => {
      const pose = createPoseState(); // facing +Z
      const moved = updatePose(pose, { dStrafe: 1.0 });
      expect(moved.x).toBeCloseTo(1.0);
      expect(moved.z).toBeCloseTo(0);
    });

    it("applies vertical movement", () => {
      const pose = createPoseState();
      const moved = updatePose(pose, { dUp: 0.5 });
      expect(moved.y).toBeCloseTo(0.5);
    });

    it("does not mutate the original state", () => {
      const pose = createPoseState();
      updatePose(pose, { dYaw: 1.0, dForward: 1.0 });
      expect(pose.yaw).toBe(0);
      expect(pose.x).toBe(0);
    });

    it("updates quaternion after movement", () => {
      const pose = createPoseState();
      const moved = updatePose(pose, { dYaw: Math.PI / 4 });
      // Quaternion should not be identity anymore
      expect(moved.qw).not.toBeCloseTo(1);
      // But should still be unit
      const mag = Math.sqrt(moved.qw ** 2 + moved.qx ** 2 + moved.qy ** 2 + moved.qz ** 2);
      expect(mag).toBeCloseTo(1);
    });
  });

  describe("setPoseAbsolute", () => {
    it("sets position fields", () => {
      const pose = createPoseState();
      const updated = setPoseAbsolute(pose, { x: 1, y: 2, z: 3 });
      expect(updated.x).toBe(1);
      expect(updated.y).toBe(2);
      expect(updated.z).toBe(3);
    });

    it("sets orientation fields", () => {
      const pose = createPoseState();
      const updated = setPoseAbsolute(pose, { yaw: 0.5, pitch: 0.3 });
      expect(updated.yaw).toBeCloseTo(0.5);
      expect(updated.pitch).toBeCloseTo(0.3);
    });

    it("preserves unset fields", () => {
      const pose = setPoseAbsolute(createPoseState(), { x: 5, yaw: 1 });
      const updated = setPoseAbsolute(pose, { y: 10 });
      expect(updated.x).toBe(5);
      expect(updated.y).toBe(10);
      expect(updated.yaw).toBeCloseTo(1);
    });

    it("does not mutate the original", () => {
      const pose = createPoseState();
      setPoseAbsolute(pose, { x: 99 });
      expect(pose.x).toBe(0);
    });
  });

  describe("screenToYawPitch", () => {
    it("maps screen center to current orientation", () => {
      const result = screenToYawPitch(0.5, 0.5, 0, 0, 1920, 1080);
      expect(result.yaw).toBeCloseTo(0);
      expect(result.pitch).toBeCloseTo(0);
    });

    it("maps left edge to positive yaw offset", () => {
      const result = screenToYawPitch(0, 0.5, 0, 0, 1920, 1080);
      expect(result.yaw).toBeGreaterThan(0);
    });

    it("maps right edge to negative yaw offset", () => {
      const result = screenToYawPitch(1, 0.5, 0, 0, 1920, 1080);
      expect(result.yaw).toBeLessThan(0);
    });

    it("respects current yaw", () => {
      const result = screenToYawPitch(0.5, 0.5, 1.0, 0, 1920, 1080);
      expect(result.yaw).toBeCloseTo(1.0);
    });
  });
});
