import com.github.javaparser.JavaParser;
import com.github.javaparser.ParseResult;
import com.github.javaparser.ParserConfiguration;
import com.github.javaparser.ast.CompilationUnit;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;

/**
 * Syntax check for Java snippets, used by tools/check_code_blocks.py.
 * Reads snippets from stdin, separated by a line "\u0000END", and prints one line per snippet:
 * "OK" or "ERR <message>". A snippet passes if it parses as a whole file, as class members,
 * or as statements inside a method (lessons show all three shapes).
 */
public class Check {
    public static void main(String[] args) throws Exception {
        JavaParser parser = new JavaParser(new ParserConfiguration()
                .setLanguageLevel(ParserConfiguration.LanguageLevel.BLEEDING_EDGE));
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        StringBuilder sb = new StringBuilder();
        String line;
        while ((line = in.readLine()) != null) {
            if (!line.equals("\u0000END")) { sb.append(line).append('\n'); continue; }
            String code = sb.toString(); sb.setLength(0);
            String[] shapes = { code, "class __W {\n" + code + "\n}",
                                "class __W { void __m() throws Exception {\n" + code + "\n} }" };
            String err = null;
            for (String s : shapes) {
                ParseResult<CompilationUnit> r = parser.parse(s);
                if (r.isSuccessful()) { err = null; break; }
                if (err == null) err = r.getProblems().get(0).getMessage().replace('\n', ' ');
            }
            System.out.println(err == null ? "OK" : "ERR " + err);
            System.out.flush();
        }
    }
}
