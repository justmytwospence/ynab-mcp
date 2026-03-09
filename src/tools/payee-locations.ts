import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getClient } from "../ynab-client.js";
import { textResult, errorResult } from "../utils/formatting.js";

export function registerPayeeLocationTools(server: McpServer) {
  server.registerTool("list_payee_locations", {
    title: "List Payee Locations",
    description: "List all payee GPS locations for a budget",
    inputSchema: {
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ budget_id }) => {
    try {
      const response = await getClient().payeeLocations.getPayeeLocations(budget_id);
      const locations = response.data.payee_locations;
      if (locations.length === 0) return textResult("No payee locations found.");
      const lines = locations.map((l) =>
        `- Payee ${l.payee_id}: (${l.latitude}, ${l.longitude}) [ID: ${l.id}]`
      );
      return textResult(`Payee Locations (${locations.length}):\n${lines.join("\n")}`);
    } catch (e: any) {
      return errorResult(e.message);
    }
  });

  server.registerTool("get_payee_location", {
    title: "Get Payee Location",
    description: "Get a single payee location by ID",
    inputSchema: {
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
      payee_location_id: z.string().describe("The payee location ID"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ budget_id, payee_location_id }) => {
    try {
      const response = await getClient().payeeLocations.getPayeeLocationById(budget_id, payee_location_id);
      const l = response.data.payee_location;
      return textResult(
        `Payee Location:\n  Payee ID: ${l.payee_id}\n  Latitude: ${l.latitude}\n  Longitude: ${l.longitude}\n  ID: ${l.id}`
      );
    } catch (e: any) {
      return errorResult(e.message);
    }
  });

  server.registerTool("get_payee_locations_for_payee", {
    title: "Get Locations for Payee",
    description: "Get all GPS locations for a specific payee",
    inputSchema: {
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
      payee_id: z.string().describe("The payee ID"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ budget_id, payee_id }) => {
    try {
      const response = await getClient().payeeLocations.getPayeeLocationsByPayee(budget_id, payee_id);
      const locations = response.data.payee_locations;
      if (locations.length === 0) return textResult("No locations found for this payee.");
      const lines = locations.map((l) =>
        `- (${l.latitude}, ${l.longitude}) [ID: ${l.id}]`
      );
      return textResult(`Locations for payee ${payee_id}:\n${lines.join("\n")}`);
    } catch (e: any) {
      return errorResult(e.message);
    }
  });
}
