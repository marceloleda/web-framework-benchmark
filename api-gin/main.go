package main

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	_ "github.com/lib/pq"
)

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

// User represents a row in the users table.
type User struct {
	ID        int       `json:"id"`
	Name      string    `json:"name"`
	Email     string    `json:"email"`
	Age       *int      `json:"age"`
	CreatedAt time.Time `json:"created_at"`
}

// CreateUserRequest is the expected body for POST /users.
type CreateUserRequest struct {
	Name  string `json:"name"  binding:"required"`
	Email string `json:"email" binding:"required"`
	Age   *int   `json:"age"`
}

// UpdateUserRequest is the expected body for PUT /users/:id.
type UpdateUserRequest struct {
	Name  *string `json:"name"`
	Email *string `json:"email"`
	Age   *int    `json:"age"`
}

// ---------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------

func setupDB() *sql.DB {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		dsn = "postgresql://benchmark:benchmark@localhost:5432/benchmark"
	}

	db, err := sql.Open("postgres", dsn)
	if err != nil {
		log.Fatalf("failed to open database: %v", err)
	}

	// Connection pool tuning — mirrors the Node.js implementations (max: 10).
	db.SetMaxOpenConns(10)
	db.SetMaxIdleConns(10)
	db.SetConnMaxLifetime(30 * time.Minute)
	db.SetConnMaxIdleTime(30 * time.Second)

	// Verify connectivity before accepting traffic.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := db.PingContext(ctx); err != nil {
		log.Fatalf("failed to connect to database: %v", err)
	}

	log.Println("database connection established")
	return db
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// parseCount clamps the ?count query parameter to [1, 500], defaulting to 1.
func parseCount(raw string) int {
	if raw == "" {
		return 1
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 {
		return 1
	}
	if n > 500 {
		return 500
	}
	return n
}

// parseID converts a URL parameter to a positive integer.
// Returns (id, true) on success, (0, false) on failure.
func parseID(raw string) (int, bool) {
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 {
		return 0, false
	}
	return n, true
}

// scanUser reads a single User from any *sql.Row / *sql.Rows via the scan func.
func scanUser(scan func(...any) error) (User, error) {
	var u User
	err := scan(&u.ID, &u.Name, &u.Email, &u.Age, &u.CreatedAt)
	return u, err
}

// isPqUniqueViolation returns true when err is a PostgreSQL unique_violation
// (SQLSTATE 23505).
//
// lib/pq exposes its error as *pq.Error with an exported Code field of type
// pq.ErrorCode (a string type alias). We use a structural interface assertion
// so we do not need to import the pq sub-package directly — it keeps the
// import surface minimal.
func isPqUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	// *pq.Error satisfies this interface: it has a method-free exported field
	// Code, but Go struct fields are not methods. We therefore rely on the
	// fact that lib/pq's error message always contains the string
	// "duplicate key value violates unique constraint" for SQLSTATE 23505.
	//
	// Alternatively, lib/pq errors can be detected via the pq package's own
	// IsConstraintViolation helper, but that requires importing lib/pq.
	// The string-match below is stable across all lib/pq versions and avoids
	// coupling to the internal type.
	type hasSQLState interface {
		SQLState() string
	}
	if e, ok := err.(hasSQLState); ok {
		return e.SQLState() == "23505"
	}
	// Fallback: inspect the error message text.
	return len(err.Error()) >= 28 &&
		func(s string) bool {
			for i := 0; i+27 < len(s); i++ {
				if s[i:i+28] == "duplicate key value violates" {
					return true
				}
			}
			return false
		}(err.Error())
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

// GET /
func handleRoot(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"message":   "Gin API",
		"framework": "gin",
		"runtime":   "go",
	})
}

// GET /json
func handleJSON(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"message":   "Hello, World!",
		"framework": "gin",
	})
}

// GET /db — single random user from the database
func handleDB(db *sql.DB) gin.HandlerFunc {
	const query = `SELECT id, name, email, age, created_at FROM users ORDER BY RANDOM() LIMIT 1`

	return func(c *gin.Context) {
		row := db.QueryRowContext(c.Request.Context(), query)
		user, err := scanUser(row.Scan)
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "No users found"})
			return
		}
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Database error", "detail": err.Error()})
			return
		}
		c.JSON(http.StatusOK, user)
	}
}

// GET /queries?count=N — N individual random-user queries (1-500, default 1)
func handleQueries(db *sql.DB) gin.HandlerFunc {
	const query = `SELECT id, name, email, age, created_at FROM users ORDER BY RANDOM() LIMIT 1`

	return func(c *gin.Context) {
		count := parseCount(c.Query("count"))

		users := make([]User, 0, count)
		for i := 0; i < count; i++ {
			row := db.QueryRowContext(c.Request.Context(), query)
			user, err := scanUser(row.Scan)
			if err == sql.ErrNoRows {
				// No data yet — return what we have so far.
				break
			}
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Database error", "detail": err.Error()})
				return
			}
			users = append(users, user)
		}

		c.JSON(http.StatusOK, users)
	}
}

// GET /users — all users ordered by id
func handleGetUsers(db *sql.DB) gin.HandlerFunc {
	const query = `SELECT id, name, email, age, created_at FROM users ORDER BY id`

	return func(c *gin.Context) {
		rows, err := db.QueryContext(c.Request.Context(), query)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Database error", "detail": err.Error()})
			return
		}
		defer rows.Close()

		users := make([]User, 0)
		for rows.Next() {
			user, err := scanUser(rows.Scan)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Database error", "detail": err.Error()})
				return
			}
			users = append(users, user)
		}
		if err := rows.Err(); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Database error", "detail": err.Error()})
			return
		}

		c.JSON(http.StatusOK, users)
	}
}

// GET /users/:id — single user by ID
func handleGetUser(db *sql.DB) gin.HandlerFunc {
	const query = `SELECT id, name, email, age, created_at FROM users WHERE id = $1`

	return func(c *gin.Context) {
		id, ok := parseID(c.Param("id"))
		if !ok {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid user ID"})
			return
		}

		row := db.QueryRowContext(c.Request.Context(), query, id)
		user, err := scanUser(row.Scan)
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "User not found"})
			return
		}
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Database error", "detail": err.Error()})
			return
		}

		c.JSON(http.StatusOK, user)
	}
}

// POST /users — create a user, respond 201 with the created object
func handleCreateUser(db *sql.DB) gin.HandlerFunc {
	const query = `
		INSERT INTO users (name, email, age)
		VALUES ($1, $2, $3)
		RETURNING id, name, email, age, created_at`

	return func(c *gin.Context) {
		var req CreateUserRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}

		row := db.QueryRowContext(c.Request.Context(), query, req.Name, req.Email, req.Age)
		user, err := scanUser(row.Scan)
		if err != nil {
			if isPqUniqueViolation(err) {
				c.JSON(http.StatusConflict, gin.H{"error": "Email already in use"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Database error", "detail": err.Error()})
			return
		}

		c.JSON(http.StatusCreated, user)
	}
}

// PUT /users/:id — update an existing user, respond with the updated object
func handleUpdateUser(db *sql.DB) gin.HandlerFunc {
	const selectQuery = `SELECT id, name, email, age, created_at FROM users WHERE id = $1`
	const updateQuery = `
		UPDATE users
		SET name = $1, email = $2, age = $3
		WHERE id = $4
		RETURNING id, name, email, age, created_at`

	return func(c *gin.Context) {
		id, ok := parseID(c.Param("id"))
		if !ok {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid user ID"})
			return
		}

		var req UpdateUserRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}

		if req.Name == nil && req.Email == nil && req.Age == nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "At least one field (name, email, age) is required"})
			return
		}

		// Fetch the existing record to merge partial updates.
		row := db.QueryRowContext(c.Request.Context(), selectQuery, id)
		current, err := scanUser(row.Scan)
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "User not found"})
			return
		}
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Database error", "detail": err.Error()})
			return
		}

		// Merge: use request value when provided, fall back to the current value.
		newName := current.Name
		if req.Name != nil {
			newName = *req.Name
		}
		newEmail := current.Email
		if req.Email != nil {
			newEmail = *req.Email
		}
		newAge := current.Age
		if req.Age != nil {
			newAge = req.Age
		}

		updateRow := db.QueryRowContext(c.Request.Context(), updateQuery, newName, newEmail, newAge, id)
		updated, err := scanUser(updateRow.Scan)
		if err == sql.ErrNoRows {
			// Race condition: deleted between SELECT and UPDATE.
			c.JSON(http.StatusNotFound, gin.H{"error": "User not found"})
			return
		}
		if err != nil {
			if isPqUniqueViolation(err) {
				c.JSON(http.StatusConflict, gin.H{"error": "Email already in use"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Database error", "detail": err.Error()})
			return
		}

		c.JSON(http.StatusOK, updated)
	}
}

// DELETE /users/:id — remove a user, respond 204 on success
func handleDeleteUser(db *sql.DB) gin.HandlerFunc {
	const query = `DELETE FROM users WHERE id = $1 RETURNING id`

	return func(c *gin.Context) {
		id, ok := parseID(c.Param("id"))
		if !ok {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid user ID"})
			return
		}

		var deletedID int
		err := db.QueryRowContext(c.Request.Context(), query, id).Scan(&deletedID)
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "User not found"})
			return
		}
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Database error", "detail": err.Error()})
			return
		}

		c.Status(http.StatusNoContent)
	}
}

// ---------------------------------------------------------------------------
// Router setup
// ---------------------------------------------------------------------------

func setupRouter(db *sql.DB) *gin.Engine {
	gin.SetMode(gin.ReleaseMode)

	r := gin.New()

	// Use only the recovery middleware — logger is omitted for benchmark throughput.
	r.Use(gin.Recovery())

	r.GET("/", handleRoot)
	r.GET("/json", handleJSON)
	r.GET("/db", handleDB(db))
	r.GET("/queries", handleQueries(db))
	r.GET("/users", handleGetUsers(db))
	r.GET("/users/:id", handleGetUser(db))
	r.POST("/users", handleCreateUser(db))
	r.PUT("/users/:id", handleUpdateUser(db))
	r.DELETE("/users/:id", handleDeleteUser(db))

	return r
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

func main() {
	db := setupDB()
	defer db.Close()

	port := os.Getenv("PORT")
	if port == "" {
		port = "3005"
	}

	router := setupRouter(db)

	srv := &http.Server{
		Addr:         fmt.Sprintf("0.0.0.0:%s", port),
		Handler:      router,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// Start the server in a goroutine so we can listen for shutdown signals.
	go func() {
		log.Printf("Gin API listening on http://0.0.0.0:%s", port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("server error: %v", err)
		}
	}()

	// Graceful shutdown: wait for SIGINT or SIGTERM.
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Println("shutting down server...")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil {
		log.Fatalf("forced shutdown: %v", err)
	}

	log.Println("server stopped")
}
