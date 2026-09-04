import {
  minutesOf,
  formatTime,
  parseRoomRef,
  findNowAndNext,
  classDueNow,
} from "../public/js/schedule-time.js";

// Days are 0-6 with Sunday first, matching Date#getDay.
const MON = 1, WED = 3, FRI = 5;

// A fixed local Wednesday so these never depend on when they are run.
const wednesdayAt = (h, m = 0) => new Date(2026, 8, 2, h, m, 0); // 2 Sep 2026 is a Wed
const fridayAt = (h, m = 0) => new Date(2026, 8, 4, h, m, 0);

const comp = {
  id: "c1", title: "COMP 7082", building: "SW3", room: "1600",
  days: [MON, WED, FRI], startTime: "09:30", endTime: "10:20",
};
const math = {
  id: "c2", title: "MATH 1441", building: "NE1", room: "201",
  days: [WED], startTime: "13:00", endTime: "14:50",
};

describe("time helpers", () => {
  it("converts HH:MM to minutes", () => {
    expect(minutesOf("00:00")).toBe(0);
    expect(minutesOf("09:30")).toBe(570);
    expect(minutesOf("23:59")).toBe(1439);
  });

  it("formats 24h times for reading", () => {
    expect(formatTime("00:05")).toBe("12:05am");
    expect(formatTime("09:30")).toBe("9:30am");
    expect(formatTime("12:00")).toBe("12:00pm");
    expect(formatTime("13:05")).toBe("1:05pm");
  });

  it("parses a room reference, and rejects one with no building", () => {
    expect(parseRoomRef("SW3-1600")).toEqual({ building: "SW3", room: "1600" });
    expect(parseRoomRef("sw3 1600")).toEqual({ building: "SW3", room: "1600" });
    expect(parseRoomRef("1600")).toBeNull();
    expect(parseRoomRef("")).toBeNull();
  });
});

describe("findNowAndNext", () => {
  const schedule = [comp, math];

  it("finds the class currently running", () => {
    const { current } = findNowAndNext(schedule, wednesdayAt(9, 45));
    expect(current.entry.title).toBe("COMP 7082");
  });

  it("treats the end time as over", () => {
    const { current } = findNowAndNext(schedule, wednesdayAt(10, 20));
    expect(current).toBeNull();
  });

  it("gives the next class later the same day", () => {
    const { next } = findNowAndNext(schedule, wednesdayAt(11, 0));
    expect(next.entry.title).toBe("MATH 1441");
    expect(next.inMinutes).toBe(120);
  });

  it("reports both the class on now and the one after it", () => {
    const { current, next } = findNowAndNext(schedule, wednesdayAt(9, 45));
    expect(current.entry.title).toBe("COMP 7082");
    expect(next.entry.title).toBe("MATH 1441");
  });

  // Without wrapping, the page goes blank all weekend -- which is exactly
  // when someone checks what they have on Monday.
  it("wraps to next week rather than running out of classes", () => {
    const { current, next } = findNowAndNext(schedule, fridayAt(18, 0));
    expect(current).toBeNull();
    expect(next.entry.title).toBe("COMP 7082");
    expect(next.day).toBe(MON);
    // Fri 18:00 -> Mon 09:30 is three days less eight and a half hours
    expect(next.inMinutes).toBe(3 * 1440 - 510);
  });

  it("handles an empty schedule", () => {
    expect(findNowAndNext([], wednesdayAt(9, 45))).toEqual({ current: null, next: null });
  });
});

describe("classDueNow (the map banner)", () => {
  const schedule = [comp, math];

  it("reports a class in progress", () => {
    expect(classDueNow(schedule, wednesdayAt(9, 45))).toMatchObject({ status: "now" });
  });

  it("reports one starting soon, with the minutes to go", () => {
    const due = classDueNow(schedule, wednesdayAt(9, 10));
    expect(due).toMatchObject({ status: "soon", until: 20 });
  });

  it("stays quiet when the next class is beyond the window", () => {
    expect(classDueNow(schedule, wednesdayAt(8, 0))).toBeNull();
  });

  it("does not look at other days", () => {
    // Tuesday morning: COMP runs Mon/Wed/Fri, so nothing is due
    expect(classDueNow(schedule, new Date(2026, 8, 1, 9, 20))).toBeNull();
  });
});
