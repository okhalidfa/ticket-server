# TicketBari Server

REST API for TicketBari, an online ticket booking platform for bus, train, launch and plane tickets.
 
## Features
- JWT protected routes for user, vendor and admin roles
- Ticket CRUD with vendor ownership checks
- Admin approval and advertisement control for tickets
- Booking lifecycle: pending → accepted/rejected → paid
- Stripe payment intent creation and transaction logging 
- Search, filter, sort and pagination on the tickets endpoint

## Tech
Express, MongoDB driver, jsonwebtoken, stripe, cors, dotenv

## Setup
```
npm install
cp .env.example .env
npm run dev
```
