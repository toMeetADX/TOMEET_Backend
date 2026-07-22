import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  scenarios: {
    api_readiness: {
      executor: "constant-arrival-rate",
      rate: 100,
      timeUnit: "1s",
      duration: "30s",
      preAllocatedVUs: 20,
      maxVUs: 100
    }
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<250"]
  }
};

const baseUrl = __ENV.API_BASE_URL || "http://localhost:4000";

export default function () {
  const response = http.get(`${baseUrl}/health`);
  check(response, { "health is 200": (result) => result.status === 200 });
  sleep(0.05);
}
