package com.fintechmastery.recon;

import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.servlet.mvc.method.annotation.ResponseEntityExceptionHandler;

@RestControllerAdvice
public class ApiErrors extends ResponseEntityExceptionHandler {

    @ExceptionHandler(StatementRejectedException.class)
    ProblemDetail rejected(StatementRejectedException e) {
        // The message names the failed check only; parser internals and file contents are not echoed back.
        return problem(HttpStatus.UNPROCESSABLE_CONTENT, "Statement rejected", e.getMessage());
    }

    @ExceptionHandler({StatementConflictException.class, BreakWorkflow.StaleBreakException.class})
    ProblemDetail conflict(RuntimeException e) {
        return problem(HttpStatus.CONFLICT, "Conflict", e.getMessage());
    }

    @ExceptionHandler(BreakWorkflow.WorkflowException.class)
    ProblemDetail workflow(BreakWorkflow.WorkflowException e) {
        return problem(HttpStatus.UNPROCESSABLE_CONTENT, "Workflow rule violated", e.getMessage());
    }

    private static ProblemDetail problem(HttpStatus status, String title, String detail) {
        ProblemDetail pd = ProblemDetail.forStatusAndDetail(status, detail);
        pd.setTitle(title);
        return pd;
    }
}
