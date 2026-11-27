# Changelog

## 0.1.0

- First version, from the MCP server template. Every lookup the Synsbasen API
  (version 1) offers: vehicles by registration number, VIN, id or image, vehicle
  search, live Motor Register data, liens and notices from the Personal
  Property Register, valuations, leasing periods, inspections, test centres,
  the model catalogue, body types, dealer plates and the token balance; and
  the watch list (list, check, watch, unwatch; the last two are writes).
- Gateway (`./gateway`): `apiKey` is required, `baseUrl` defaults to
  `https://api.synsbasen.dk/v1`, and the key is sent only to `api.synsbasen.dk`
  as `Authorization: Bearer <key>`. Errors carry only the HTTP status and the
  vendor's request id.
