// __tests__/controller.test.js
import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";

// Indoor routing now runs in-process against the room/corridor/door GeoJSON
// (services/indoorGraph.js) instead of shelling out to a Python script, so
// the controller only needs to be tested against that module's contract.
jest.unstable_mockModule("../services/indoorGraph.js", () => ({
    findIndoorPath: jest.fn(),
}));

const { findIndoorPath } = await import("../services/indoorGraph.js");
const { handlePathRequest } = await import("../controllers/pathfinderController.js");

const app = express();
app.use(express.json());
app.post("/find-path", handlePathRequest);

describe("Path Request Handler (handlePathRequest)", () => {
    const mockPath = [
        { building: "SW3", floor: "1", room: "1615", type: "room", coord: [-123.001, 49.251] },
        { building: "SW3", floor: "1", room: "1990", type: "room", coord: [-123.002, 49.252] },
    ];

    beforeEach(() => {
        findIndoorPath.mockClear();
    });

    test("calls findIndoorPath with the building and both rooms", async () => {
        findIndoorPath.mockReturnValue({ success: true, path: mockPath, distanceM: 42 });

        await request(app)
            .post("/find-path")
            .send({ building: "SW3", startRoom: "1615", goalRoom: "1990" });

        expect(findIndoorPath).toHaveBeenCalledTimes(1);
        expect(findIndoorPath).toHaveBeenCalledWith("SW3", "1615", "1990");
    });

    test("returns 200 with the route on success", async () => {
        findIndoorPath.mockReturnValue({ success: true, path: mockPath, distanceM: 42 });

        const res = await request(app)
            .post("/find-path")
            .send({ building: "SW3", startRoom: "1615", goalRoom: "1990" });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, path: mockPath, distanceM: 42 });
    });

    test("returns success: false with a message when no route exists", async () => {
        findIndoorPath.mockReturnValue({ success: false, message: "No route found." });

        const res = await request(app)
            .post("/find-path")
            .send({ building: "SW3", startRoom: "1615", goalRoom: "9999" });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: false, message: "No route found." });
        expect(findIndoorPath).toHaveBeenCalledTimes(1);
    });

    test("400s when startRoom/goalRoom are missing, without calling findIndoorPath", async () => {
        const res = await request(app)
            .post("/find-path")
            .send({ building: "SW3" });

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(findIndoorPath).not.toHaveBeenCalled();
    });

    test("rejects cross-building requests without calling findIndoorPath", async () => {
        const res = await request(app)
            .post("/find-path")
            .send({
                startBuildingCode: "SW3",
                goalBuildingCode: "SW5",
                startRoom: "1615",
                goalRoom: "1845",
            });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(false);
        expect(findIndoorPath).not.toHaveBeenCalled();
    });

    test("falls back to startBuildingCode/goalBuildingCode when building is omitted", async () => {
        findIndoorPath.mockReturnValue({ success: true, path: mockPath, distanceM: 10 });

        await request(app)
            .post("/find-path")
            .send({
                startBuildingCode: "SW3",
                goalBuildingCode: "SW3",
                startRoom: "1615",
                goalRoom: "1990",
            });

        expect(findIndoorPath).toHaveBeenCalledWith("SW3", "1615", "1990");
    });
});
