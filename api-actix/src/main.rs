use actix_web::{delete, get, post, put, web, App, HttpResponse, HttpServer, Responder};
use chrono::{DateTime, Utc};
use deadpool_postgres::{Config as DeadpoolConfig, ManagerConfig, Pool, PoolConfig, RecyclingMethod, Runtime};
use serde::{Deserialize, Serialize};
use std::env;
use tokio_postgres::NoTls;

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/// Represents a row in the `users` table.
#[derive(Debug, Serialize, Deserialize)]
pub struct User {
    pub id: i32,
    pub name: String,
    pub email: String,
    pub age: Option<i32>,
    pub created_at: DateTime<Utc>,
}

/// Request body for POST /users.
#[derive(Debug, Deserialize)]
pub struct CreateUser {
    pub name: String,
    pub email: String,
    pub age: Option<i32>,
}

/// Request body for PUT /users/:id.
#[derive(Debug, Deserialize)]
pub struct UpdateUser {
    pub name: Option<String>,
    pub email: Option<String>,
    pub age: Option<i32>,
}

// ---------------------------------------------------------------------------
// Application state
// ---------------------------------------------------------------------------

pub struct AppState {
    pub pool: Pool,
}

// ---------------------------------------------------------------------------
// Helper: map a postgres Row into a User
// ---------------------------------------------------------------------------

fn row_to_user(row: &tokio_postgres::Row) -> User {
    User {
        id: row.get("id"),
        name: row.get("name"),
        email: row.get("email"),
        age: row.get("age"),
        created_at: row.get("created_at"),
    }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// GET /
#[get("/")]
async fn index() -> impl Responder {
    HttpResponse::Ok().json(serde_json::json!({
        "message": "Actix-web API",
        "framework": "actix-web",
        "runtime": "rust"
    }))
}

/// GET /json
#[get("/json")]
async fn json_endpoint() -> impl Responder {
    HttpResponse::Ok().json(serde_json::json!({
        "message": "Hello, World!",
        "framework": "actix-web"
    }))
}

/// GET /db  — returns one random user from the database.
#[get("/db")]
async fn db_endpoint(data: web::Data<AppState>) -> impl Responder {
    let client = match data.pool.get().await {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Pool error: {e}");
            return HttpResponse::InternalServerError()
                .json(serde_json::json!({ "error": "Database connection error" }));
        }
    };

    let row = match client
        .query_opt(
            "SELECT id, name, email, age, created_at \
             FROM users ORDER BY RANDOM() LIMIT 1",
            &[],
        )
        .await
    {
        Ok(Some(r)) => r,
        Ok(None) => {
            return HttpResponse::NotFound()
                .json(serde_json::json!({ "error": "No users found" }));
        }
        Err(e) => {
            eprintln!("Query error: {e}");
            return HttpResponse::InternalServerError()
                .json(serde_json::json!({ "error": "Database query error" }));
        }
    };

    HttpResponse::Ok().json(row_to_user(&row))
}

/// Query parameters for GET /queries.
#[derive(Deserialize)]
pub struct QueriesParams {
    count: Option<i64>,
}

/// GET /queries?count=N  — returns N random users (1 ≤ N ≤ 500, default 1).
#[get("/queries")]
async fn queries_endpoint(
    data: web::Data<AppState>,
    query: web::Query<QueriesParams>,
) -> impl Responder {
    let count = query.count.unwrap_or(1).clamp(1, 500);

    let client = match data.pool.get().await {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Pool error: {e}");
            return HttpResponse::InternalServerError()
                .json(serde_json::json!({ "error": "Database connection error" }));
        }
    };

    let rows = match client
        .query(
            "SELECT id, name, email, age, created_at \
             FROM users ORDER BY RANDOM() LIMIT $1",
            &[&count],
        )
        .await
    {
        Ok(r) => r,
        Err(e) => {
            eprintln!("Query error: {e}");
            return HttpResponse::InternalServerError()
                .json(serde_json::json!({ "error": "Database query error" }));
        }
    };

    let users: Vec<User> = rows.iter().map(row_to_user).collect();
    HttpResponse::Ok().json(users)
}

/// GET /users  — returns all users.
#[get("/users")]
async fn get_users(data: web::Data<AppState>) -> impl Responder {
    let client = match data.pool.get().await {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Pool error: {e}");
            return HttpResponse::InternalServerError()
                .json(serde_json::json!({ "error": "Database connection error" }));
        }
    };

    let rows = match client
        .query(
            "SELECT id, name, email, age, created_at FROM users ORDER BY id",
            &[],
        )
        .await
    {
        Ok(r) => r,
        Err(e) => {
            eprintln!("Query error: {e}");
            return HttpResponse::InternalServerError()
                .json(serde_json::json!({ "error": "Database query error" }));
        }
    };

    let users: Vec<User> = rows.iter().map(row_to_user).collect();
    HttpResponse::Ok().json(users)
}

/// GET /users/:id  — returns a single user by primary key.
#[get("/users/{id}")]
async fn get_user_by_id(data: web::Data<AppState>, path: web::Path<i32>) -> impl Responder {
    let id = path.into_inner();

    let client = match data.pool.get().await {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Pool error: {e}");
            return HttpResponse::InternalServerError()
                .json(serde_json::json!({ "error": "Database connection error" }));
        }
    };

    match client
        .query_opt(
            "SELECT id, name, email, age, created_at FROM users WHERE id = $1",
            &[&id],
        )
        .await
    {
        Ok(Some(row)) => HttpResponse::Ok().json(row_to_user(&row)),
        Ok(None) => {
            HttpResponse::NotFound().json(serde_json::json!({ "error": "User not found" }))
        }
        Err(e) => {
            eprintln!("Query error: {e}");
            HttpResponse::InternalServerError()
                .json(serde_json::json!({ "error": "Database query error" }))
        }
    }
}

/// POST /users  — creates a user and returns 201 with the new object.
#[post("/users")]
async fn create_user(
    data: web::Data<AppState>,
    body: web::Json<CreateUser>,
) -> impl Responder {
    let client = match data.pool.get().await {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Pool error: {e}");
            return HttpResponse::InternalServerError()
                .json(serde_json::json!({ "error": "Database connection error" }));
        }
    };

    match client
        .query_one(
            "INSERT INTO users (name, email, age) \
             VALUES ($1, $2, $3) \
             RETURNING id, name, email, age, created_at",
            &[&body.name, &body.email, &body.age],
        )
        .await
    {
        Ok(row) => HttpResponse::Created().json(row_to_user(&row)),
        Err(e) => {
            eprintln!("Insert error: {e}");
            // Duplicate email produces a unique-constraint violation (code 23505).
            let msg = e.to_string();
            if msg.contains("23505") || msg.contains("unique") {
                HttpResponse::Conflict()
                    .json(serde_json::json!({ "error": "Email already exists" }))
            } else {
                HttpResponse::InternalServerError()
                    .json(serde_json::json!({ "error": "Database insert error" }))
            }
        }
    }
}

/// PUT /users/:id  — updates a user and returns the updated object, or 404.
#[put("/users/{id}")]
async fn update_user(
    data: web::Data<AppState>,
    path: web::Path<i32>,
    body: web::Json<UpdateUser>,
) -> impl Responder {
    let id = path.into_inner();

    let client = match data.pool.get().await {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Pool error: {e}");
            return HttpResponse::InternalServerError()
                .json(serde_json::json!({ "error": "Database connection error" }));
        }
    };

    // Build dynamic SET clause from the fields present in the body.
    // We collect only the columns that were actually provided.
    let mut set_clauses: Vec<String> = Vec::new();
    let mut param_index: i32 = 1;

    if body.name.is_some() {
        set_clauses.push(format!("name = ${param_index}"));
        param_index += 1;
    }
    if body.email.is_some() {
        set_clauses.push(format!("email = ${param_index}"));
        param_index += 1;
    }
    if body.age.is_some() {
        set_clauses.push(format!("age = ${param_index}"));
        param_index += 1;
    }

    if set_clauses.is_empty() {
        // Nothing to update; fetch and return the existing record.
        return match client
            .query_opt(
                "SELECT id, name, email, age, created_at FROM users WHERE id = $1",
                &[&id],
            )
            .await
        {
            Ok(Some(row)) => HttpResponse::Ok().json(row_to_user(&row)),
            Ok(None) => {
                HttpResponse::NotFound().json(serde_json::json!({ "error": "User not found" }))
            }
            Err(e) => {
                eprintln!("Query error: {e}");
                HttpResponse::InternalServerError()
                    .json(serde_json::json!({ "error": "Database query error" }))
            }
        };
    }

    let sql = format!(
        "UPDATE users SET {} WHERE id = ${} \
         RETURNING id, name, email, age, created_at",
        set_clauses.join(", "),
        param_index
    );

    // Build the boxed parameter list dynamically.
    // tokio-postgres expects &[&(dyn ToSql + Sync)].
    let mut params: Vec<Box<dyn tokio_postgres::types::ToSql + Sync>> = Vec::new();
    if let Some(ref name) = body.name {
        params.push(Box::new(name.clone()));
    }
    if let Some(ref email) = body.email {
        params.push(Box::new(email.clone()));
    }
    if let Some(age) = body.age {
        params.push(Box::new(age));
    }
    params.push(Box::new(id));

    // Convert to the slice form expected by tokio-postgres.
    let params_refs: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> =
        params.iter().map(|p| p.as_ref()).collect();

    match client.query_opt(&sql, params_refs.as_slice()).await {
        Ok(Some(row)) => HttpResponse::Ok().json(row_to_user(&row)),
        Ok(None) => {
            HttpResponse::NotFound().json(serde_json::json!({ "error": "User not found" }))
        }
        Err(e) => {
            eprintln!("Update error: {e}");
            HttpResponse::InternalServerError()
                .json(serde_json::json!({ "error": "Database update error" }))
        }
    }
}

/// DELETE /users/:id  — removes a user and returns 204, or 404.
#[delete("/users/{id}")]
async fn delete_user(data: web::Data<AppState>, path: web::Path<i32>) -> impl Responder {
    let id = path.into_inner();

    let client = match data.pool.get().await {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Pool error: {e}");
            return HttpResponse::InternalServerError()
                .json(serde_json::json!({ "error": "Database connection error" }));
        }
    };

    match client
        .execute("DELETE FROM users WHERE id = $1", &[&id])
        .await
    {
        Ok(rows_affected) if rows_affected == 0 => {
            HttpResponse::NotFound().json(serde_json::json!({ "error": "User not found" }))
        }
        Ok(_) => HttpResponse::NoContent().finish(),
        Err(e) => {
            eprintln!("Delete error: {e}");
            HttpResponse::InternalServerError()
                .json(serde_json::json!({ "error": "Database delete error" }))
        }
    }
}

// ---------------------------------------------------------------------------
// Pool construction
// ---------------------------------------------------------------------------

/// Builds a `deadpool-postgres` pool from DATABASE_URL.
///
/// `tokio-postgres` understands `postgresql://` connection strings natively
/// through its `FromStr` impl on `Config`.  We parse the URL there and then
/// mirror every field into `deadpool_postgres::Config` so the pool manager
/// can open connections using the same parameters.
///
/// `NoTls` is appropriate here because all containers share a private Docker
/// Compose network — TLS overhead would skew the benchmark numbers without
/// providing real security value.
fn build_pool(database_url: &str) -> Result<Pool, Box<dyn std::error::Error>> {
    // Let tokio-postgres handle URL parsing; it supports the full
    // `postgresql://user:pass@host:port/dbname` syntax.
    let pg: tokio_postgres::Config = database_url.parse()?;

    let mut cfg = DeadpoolConfig::new();

    // --- host ---
    // `get_hosts()` returns a slice of `tokio_postgres::config::Host`.
    // We only need the first one.  The `Host` enum variants are `Tcp(String)`
    // and `Unix(PathBuf)`; we handle both defensively.
    if let Some(host) = pg.get_hosts().first() {
        cfg.host = Some(match host {
            tokio_postgres::config::Host::Tcp(h) => h.clone(),
            tokio_postgres::config::Host::Unix(p) => {
                p.to_string_lossy().into_owned()
            }
        });
    }

    // --- port ---
    // Ports list is aligned with hosts; take the first entry (default: 5432).
    if let Some(&port) = pg.get_ports().first() {
        cfg.port = Some(port);
    }

    // --- credentials & database name ---
    cfg.dbname   = pg.get_dbname().map(str::to_owned);
    cfg.user     = pg.get_user().map(str::to_owned);
    cfg.password = pg.get_password().map(|b| String::from_utf8_lossy(b).into_owned());

    // --- pool & manager settings ---
    cfg.manager = Some(ManagerConfig {
        recycling_method: RecyclingMethod::Fast,
    });

    // `PoolConfig::new(max_size)` sets the maximum connection count.
    cfg.pool = Some(PoolConfig::new(10));

    let pool = cfg.create_pool(Some(Runtime::Tokio1), NoTls)?;

    Ok(pool)
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    // Load .env file if present (ignored in Docker where vars are injected).
    let _ = dotenvy::dotenv();

    let database_url =
        env::var("DATABASE_URL").expect("DATABASE_URL environment variable must be set");
    let port: u16 = env::var("PORT")
        .unwrap_or_else(|_| "3004".to_string())
        .parse()
        .expect("PORT must be a valid u16");

    let pool = build_pool(&database_url).expect("Failed to build database connection pool");

    // Eagerly verify the pool works before binding the HTTP server.
    {
        let client = pool
            .get()
            .await
            .expect("Failed to obtain initial DB connection from pool");
        client
            .execute("SELECT 1", &[])
            .await
            .expect("Initial DB ping failed");
        println!("Database connection pool ready.");
    }

    let pool = web::Data::new(AppState { pool });
    let bind_addr = format!("0.0.0.0:{port}");

    println!("Starting Actix-web server on {bind_addr}");

    HttpServer::new(move || {
        App::new()
            .app_data(pool.clone())
            // Return a proper JSON 400 when the request body cannot be deserialized.
            .app_data(
                web::JsonConfig::default()
                    .error_handler(|err, _req| {
                        let response = HttpResponse::BadRequest()
                            .json(serde_json::json!({ "error": err.to_string() }));
                        actix_web::error::InternalError::from_response(err, response).into()
                    }),
            )
            // Return a proper JSON 400 when query params cannot be deserialized.
            .app_data(
                web::QueryConfig::default()
                    .error_handler(|err, _req| {
                        let response = HttpResponse::BadRequest()
                            .json(serde_json::json!({ "error": err.to_string() }));
                        actix_web::error::InternalError::from_response(err, response).into()
                    }),
            )
            .service(index)
            .service(json_endpoint)
            .service(db_endpoint)
            .service(queries_endpoint)
            .service(get_users)
            .service(get_user_by_id)
            .service(create_user)
            .service(update_user)
            .service(delete_user)
    })
    // Use all available logical CPUs for maximum throughput.
    .workers(num_cpus())
    // Graceful shutdown: wait up to 30 s for in-flight requests.
    .shutdown_timeout(30)
    .bind(&bind_addr)?
    .run()
    .await
}

/// Returns the number of logical CPUs available, with a sensible minimum.
fn num_cpus() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
}
